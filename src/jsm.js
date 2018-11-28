var mixin = require("./util/mixin"),
  Exception = require("./util/exception"),
  plugin = require("./plugin"),
  UNOBSERVED = [null, []];

//-------------------------------------------------------------------------------------------------

function JSM(context, config) {
  this.context = context;
  this.config = config;
  this.state = config.init.from;
  this.observers = [context];
  this.subscriptions = [];
}

//-------------------------------------------------------------------------------------------------

mixin(JSM.prototype, {
  init: function(args) {
    mixin(this.context, this.config.data.apply(this.context, args));
    plugin.hook(this, "init");
    if (this.config.init.active) return this.fire(this.config.init.name, []);
  },

  is: function(state) {
    return Array.isArray(state)
      ? state.indexOf(this.state) >= 0
      : this.state === state;
  },

  isPending: function() {
    return this.pending;
  },

  lifecycle: function() {
    return this.config.lifecycle;
  },

  can: function(transition) {
    return !this.isPending() && !!this.seek(transition);
  },

  cannot: function(transition) {
    return !this.can(transition);
  },

  allStates: function() {
    return this.config.allStates();
  },

  allTransitions: function() {
    return this.config.allTransitions();
  },

  transitions: function() {
    return this.config.transitionsFor(this.state);
  },

  waitForState: function() {
    var _this = this;
    console.log('is pending, waiting for state');
    return new Promise(function(resolve, reject) {
      _this.subscriptions.push({ resolve: resolve, reject: reject });
    });
  },

  seek: function(transition, args) {
    var wildcard = this.config.defaults.wildcard,
      entry = this.config.transitionFor(this.state, transition),
      to = entry && entry.to;
    if (typeof to === "function") return to.apply(this.context, args);
    else if (to === wildcard) return this.state;
    else return to;
  },

  fire: function(transition, args) {
    console.log('firing transition', transition);
    return this.transit(
      transition,
      this.state,
      this.seek(transition, args),
      args
    );
  },

  beginTransit: function(transition, from, to, args) {
    var _this = this;
    var lifecycle = this.config.lifecycle,
      changed = this.config.options.observeUnchangedState || from !== to;
    this.config.addState(to); // might need to add this state if it's unknown (e.g. conditional transition or goto)
    console.log('beginning transit and setting pending true', transition);
    this.pending = true;

    args.unshift({
      // this context will be passed to each lifecycle event observer
      transition: transition,
      from: from,
      to: to,
      fsm: this.context
    });

    return new Promise(function(resolve, reject) {
      const finalResult = _this.observeEvents(
        [
          _this.observersForEvent(lifecycle.onBefore.transition),
          _this.observersForEvent(lifecycle.onBefore[transition]),
          changed ? _this.observersForEvent(lifecycle.onLeave.state) : UNOBSERVED,
          changed ? _this.observersForEvent(lifecycle.onLeave[from]) : UNOBSERVED,
          _this.observersForEvent(lifecycle.on.transition),
          changed ? ["doTransit", [_this]] : UNOBSERVED,
          changed ? _this.observersForEvent(lifecycle.onEnter.state) : UNOBSERVED,
          changed ? _this.observersForEvent(lifecycle.onEnter[to]) : UNOBSERVED,
          changed ? _this.observersForEvent(lifecycle.on[to]) : UNOBSERVED,
          _this.observersForEvent(lifecycle.onAfter.transition),
          _this.observersForEvent(lifecycle.onAfter[transition]),
          _this.observersForEvent(lifecycle.on[transition])
        ],
        args
      );
      if (finalResult && typeof finalResult.then === "function") {
        return finalResult.then(function(result) {
          resolve(result);
        }).catch(function(err) {
          reject(err);
        });
      }
      resolve(finalResult);
    });
  },

  transit: function(transition, from, to, args) {
    var _this = this;
    console.log('checking if pending', transition);
    if (this.isPending()) {
      console.log('was pending', transition);
      return this.waitForState()
        .then(function() {
          _this.pending = false;
          return _this.fire(transition, args);
        })
        .catch(function(result) {
          return Promise.reject(result);
        });
    }
    console.log('was not pending, starting transition', transition);
    if (!to) {
      return this.context.onInvalidTransition(transition, from, to).then(function(error) {
        _this.failTransit(error);
      });
    }
    return this.beginTransit(transition, from, to, args);
  },
  endTransit: function(args, result) {
    console.log('ending tansit');
    var to = args[0].to;
    if (this.subscriptions.length !== 0) {
      console.log('resolving subscription');
      this.subscriptions.shift().resolve();
    } else {
      console.log('no subscriptions, setting pending false');
      this.pending = false;
    }
    return result;
  },
  failTransit: function(error) {
    console.log('transition failed, moving on');
    if (this.subscriptions.length !== 0) {
      console.log('resolving subscription from fail');
      this.subscriptions.shift().resolve();
    } else {
      console.log('no subscriptions, setting pending false from fail');
      this.pending = false;
    }
    throw error;
  },
  doTransit: function(lifecycle) {
    this.state = lifecycle.to;
  },

  observe: function(args) {
    if (args.length === 2) {
      var observer = {};
      observer[args[0]] = args[1];
      this.observers.push(observer);
    } else {
      this.observers.push(args[0]);
    }
  },

  observersForEvent: function(event) {
    // TODO: this could be cached
    var n = 0,
      max = this.observers.length,
      observer,
      result = [];
    for (; n < max; n++) {
      observer = this.observers[n];
      if (observer[event]) result.push(observer);
    }
    return [event, result, true];
  },

  observeEvents: function(events, args, previousEvent, previousResult) {
    if (events.length === 0) {
      return this.endTransit(
        args,
        previousResult === undefined ? true : previousResult
      );
    }

    var event = events[0][0],
      observers = events[0][1],
      pluggable = events[0][2];

    args[0].event = event;
    if (event && pluggable && event !== previousEvent)
      plugin.hook(this, "lifecycle", args);

    if (observers.length === 0) {
      events.shift();
      return this.observeEvents(events, args, event, previousResult);
    } else {
      var observer = observers.shift(),
        result = observer[event].apply(observer, args);
      if (result && typeof result.then === "function") {
        return result
          .then(this.observeEvents.bind(this, events, args, event))
          .catch(this.failTransit.bind(this));
      } else if (result === false) {
        return this.endTransit(args, false);
      } else {
        return this.observeEvents(events, args, event, result);
      }
    }
  },

  onInvalidTransition: function(transition, from, to) {
    Promise.reject("transition is invalid in current state");
  },

  onPendingTransition: function(transition, from, to) {
    throw new Exception(
      "transition is invalid while previous transition is still in progress",
      transition,
      from,
      to,
      this.state
    );
  }
});

//-------------------------------------------------------------------------------------------------

module.exports = JSM;

//-------------------------------------------------------------------------------------------------
