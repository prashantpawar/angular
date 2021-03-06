/**
 * @fileoverview
 * Defines an extension to angular.Scope that allows for registering
 * 'gating functions' on a scope that will prevent all future watchers
 * registered on the scope from being evaluated unless the gating function
 * returns true.
 *
 * By depending on this module, the $rootScope instance and angular.Scope
 * class are automatically extended to implement this new capability.
 *
 * Warning, this implementation depends on protected/private variables
 * in the angular.Scope implementation and therefore can break in the
 * future due to changes in the angular.Scope implementation.  Use at
 * your own risk.
 */
defineScalyrAngularModule('gatedScope', [])
.config(['$provide', function($provide) {
  // We use a decorator to override methods in $rootScope.
  $provide.decorator('$rootScope', ['$delegate', '$exceptionHandler', 
      function ($rootScope, $exceptionHandler) {

    // Make a copy of $rootScope's original methods so that we can access
    // them to invoke super methods in the ones we override.
    scopePrototype = {};
    for (var key in $rootScope) {
      if (isFunction($rootScope[key]))
        scopePrototype[key] = $rootScope[key];
    }

    var Scope = $rootScope.constructor;

    // Hold all of our new methods.
    var methodsToAdd = {
    };

    // A constant value that the $digest loop implementation depends on.  We
    // grab it down below.
    var initWatchVal;

    /**
     * @param {Boolean} isolate Whether or not the new scope should be isolated.
     * @returns {Scope} A new child scope
     */
    methodsToAdd.$new = function(isolate) {
      // Because of how scope.$new works, the returned result
      // should already have our new methods.
      var result = scopePrototype.$new.call(this, isolate);
      
      // We just have to do the work that normally a child class's
      // constructor would perform -- initializing our instance vars.
      result.$$gatingFunction = this.$$gatingFunction;
      result.$$shouldGateFunction = this.$$shouldGateFunction;
      result.$$gatedWatchers = [];

      return result;
    };

    /**
     * Digests all of the gated watchers for the specified gating function.
     *
     * @param {Function} targetGatingFunction The gating function associated
     *   with the watchers that should be digested
     * @returns {Boolean} True if any of the watchers were dirty
     */
    methodsToAdd.$digestGated = function gatedScopeDigest(targetGatingFunction) {
      // Note, most of this code was stolen from angular's Scope.$digest method.
      var watch, value,
        watchers,
        length,
        next, current = this, target = this,
        dirty = false;

      do { // "traverse the scopes" loop
        if (watchers = current.$$gatedWatchers) {
          // process our watches
          length = watchers.length;
          while (length--) {
            try {
              watch = watchers[length];
              // Scalyr edit: We do not process a watch function if it is does not
              // have the same gating function for which $digestGated was invoked.
              if (watch.gatingFunction !== targetGatingFunction)
                continue;

              // Most common watches are on primitives, in which case we can short
              // circuit it with === operator, only when === fails do we use .equals
              if (watch && (value = watch.get(current)) !== (last = watch.last) &&
                  !(watch.eq
                      ? areEqual(value, last)
                      : (typeof value == 'number' && typeof last == 'number'
                        && isNaN(value) && isNaN(last)))) {
                dirty = true;
                watch.last = watch.eq ? copy(value) : value;
                watch.fn(value, ((last === initWatchVal) ? value : last), current);
                // Scalyr edit:  Removed the logging code for when the ttl is reached
                // here because we don't have access to the ttl in this method.
              }
            } catch (e) {
              $exceptionHandler(e);
            }
          }
        }

        // Insanity Warning: scope depth-first traversal
        // yes, this code is a bit crazy, but it works and we have tests to prove it!
        // Scalyr edit: This insanity warning was from angular.  We only modified this
        // code by checking the $$gatingFunction because it's a good optimization to only go
        // down a child of a parent that has the same gating function as what we are processing
        // (since if a parent already has a different gating function, there's no way any
        // of its children will have the right one).
        if (!(next = ((current.$$gatingFunction === targetGatingFunction && current.$$childHead)
              || (current !== target && current.$$nextSibling)))) {
          while(current !== target && !(next = current.$$nextSibling)) {
            current = current.$parent;
          }
        }
      } while ((current = next));

      return dirty;
    };

    /**
     * @inherited $watch
     * @param directiveName The fourth parameter is a new optional parameter that allows
     *   directives aware of this abstraction to pass in their own names to identify
     *   which directive is registering the watch.  This is then passed to the
     *   shouldGateFunction to help determine if the watcher should be gated by the current
     *   gatingFunction.
     */
    methodsToAdd.$watch = function gatedWatch(watchExpression, listener, objectEquality,
        directiveName) {
      // Determine if we should gate this watcher.
      if (!isNull(this.$$gatingFunction) && (isNull(this.$$shouldGateFunction) ||
          this.$$shouldGateFunction(watchExpression, listener, objectEquality, directiveName)))  {
        // We do a hack here to just switch out the watchers array with our own
        // gated list and then invoke the original watch function.
        var tmp = this.$$watchers;
        this.$$watchers = this.$$gatedWatchers;
        // Invoke original watch function.
        var result = scopePrototype.$watch.call(this, watchExpression, listener, objectEquality);
        this.$$watchers = tmp;
        this.$$gatedWatchers[0].gatingFunction = this.$$gatingFunction;

        // We know that the last field of the watcher object will be set to initWatchVal, so we
        // grab it here.
        initWatchVal = this.$$gatedWatchers[0].last;

        return result;
      } else {
        return scopePrototype.$watch.call(this, watchExpression, listener, objectEquality);
      }
    };
    
    /**
     * Modifies this scope so that all future watchers registered by $watch will
     * only be evaluated if gatingFunction returns true.  Optionally, you may specify
     * a function that will be evaluted on every new call to $watch with the arguments
     * passed to it, and that watcher will only be gated if the function returns true.
     *
     * @param {Function} gatingFunction The gating function which controls whether or not all future
     *   watchers registered on this scope and its children will be evaluated on a given
     *   digest cycle.  The function will be invoked (with no arguments) on every digest
     *   and if it returns a truthy result, will cause all gated watchers to be evaluated.
     * @param {Function} shouldGateFunction The function that controls whether or not
     *   a new watcher will be gated using gatingFunction.  It is evaluated with the
     *   arguments to $watch and should return true if the watcher created by those
     *   arguments should be gated
     */
    methodsToAdd.$addWatcherGate = function(gatingFunction, shouldGateFunction) {
      var changeCount = 0;
      var self = this;

      // Set a watcher that sees if our gating function is true, and if so, digests
      // all of our associated watchers.  Note, this.$watch could already have a
      // gating function associated with it, which means this watch won't be executed
      // unless all gating functions before us have evaluated to true.  We take special
      // care of this nested case below.

      // We handle nested gating function in a special way.  If we are a nested gating
      // function (meaning there is already one or more gating functions on this scope and
      // our parent scopes), then if those parent gating functions every all evaluate to
      // true (which we can tell if the watcher we register here is evaluated), then
      // we always evaluate our watcher until our gating function returns true.
      var hasNestedGates = !isNull(this.$$gatingFunction);
      var promotedWatcher = null;

      this.$watch(function() {
        if (gatingFunction()) {
          if (self.$digestGated(gatingFunction))
            ++changeCount;
        } else if (hasNestedGates && isNull(promotedWatcher)) {
          promotedWatcher = scopePrototype.$watch.call(self, function() {
            if (gatingFunction()) {
              promotedWatcher();
              promotedWatcher = null;
              if (self.$digestGated(gatingFunction))
                ++changeCount;
            }
            return changeCount;
          });
        }
        return changeCount;
      });


      if (isUndefined(shouldGateFunction))
        shouldGateFunction = null;
      this.$$gatingFunction = gatingFunction;
      this.$$shouldGateFunction = shouldGateFunction;
    };

    // Extend the original Scope object so that when
    // new instances are created, it has the new methods.
    angular.extend(Scope.prototype, methodsToAdd);

    // Also extend the $rootScope instance since it was created
    // before we got a chance to extend Scope.prototype.
    angular.extend($rootScope, methodsToAdd);

    $rootScope.$$gatingFunction = null;
    $rootScope.$$shouldGateFunction = null;
    $rootScope.$$gatedWatchers = [];

    return $rootScope;
  }]);
}]);
