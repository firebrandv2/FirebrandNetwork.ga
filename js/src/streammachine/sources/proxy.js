var Icy, ProxySource, debug, domain, url, util, _,
  __hasProp = {}.hasOwnProperty,
  __extends = function(child, parent) { for (var key in parent) { if (__hasProp.call(parent, key)) child[key] = parent[key]; } function ctor() { this.constructor = child; } ctor.prototype = parent.prototype; child.prototype = new ctor(); child.__super__ = parent.prototype; return child; };

Icy = require('icy');

util = require('util');

url = require('url');

domain = require("domain");

_ = require("underscore");

debug = require("debug")("sm:sources:proxy");

module.exports = ProxySource = (function(_super) {
  __extends(ProxySource, _super);

  ProxySource.prototype.TYPE = function() {
    return "Proxy (" + this.url + ")";
  };

  function ProxySource(opts) {
    var _ref;
    this.opts = opts;
    ProxySource.__super__.constructor.call(this, {
      useHeartbeat: false
    });
    this.url = this.opts.url;
    if ((_ref = this.log) != null) {
      _ref.debug("ProxySource created for " + this.url);
    }
    this.isFallback = this.opts.fallback || false;
    this.connected = false;
    this.framesPerSec = null;
    this.last_ts = null;
    this.connected_at = null;
    this._in_disconnect = false;
    this._maxBounces = 10;
    this._bounces = 0;
    this._bounceInt = 5;
    this.StreamTitle = null;
    this.StreamUrl = null;
    this.d = domain.create();
    this.d.on("error", (function(_this) {
      return function(err) {
        return _this._niceError(err);
      };
    })(this));
    this.d.run((function(_this) {
      return function() {
        return _this.connect();
      };
    })(this));
  }

  ProxySource.prototype._niceError = function(err) {
    var nice_err, _ref;
    debug("Caught error: " + err, err.stack);
    nice_err = (function() {
      switch (err.syscall) {
        case "getaddrinfo":
          return "Unable to look up DNS for Icecast proxy";
        case "connect":
          return "Unable to connect to Icecast proxy. Connection Refused";
        default:
          return "Error making connection to Icecast proxy";
      }
    })();
    return (_ref = this.log) != null ? _ref.error("ProxySource encountered an error: " + nice_err, err) : void 0;
  };

  ProxySource.prototype.status = function() {
    var _ref;
    return {
      source: (_ref = typeof this.TYPE === "function" ? this.TYPE() : void 0) != null ? _ref : this.TYPE,
      connected: this.connected,
      url: this.url,
      streamKey: this.streamKey,
      uuid: this.uuid,
      isFallback: this.isFallback,
      last_ts: this.last_ts,
      connected_at: this.connected_at
    };
  };

  ProxySource.prototype.connect = function() {
    var ireq, url_opts, _reconnect, _ref;
    if ((_ref = this.log) != null) {
      _ref.debug("connecting to " + this.url);
    }
    url_opts = url.parse(this.url);
    url_opts.headers = {
      "user-agent": "StreamMachine 0.1.0"
    };
    debug("Connecting to " + this.url);
    _reconnect = _.once((function(_this) {
      return function() {
        var _ref1, _ref2;
        if (!_this._in_disconnect) {
          debug("Engaging reconnect logic");
          setTimeout((function() {
            return _this.connect();
          }), 1000);
          if ((_ref1 = _this.log) != null) {
            _ref1.debug("Lost or failed to make connection to " + _this.url + ". Retrying in one second.");
          }
          _this.connected = false;
          if ((_ref2 = _this.icecast) != null) {
            _ref2.removeAllListeners();
          }
          return _this.icecast = null;
        }
      };
    })(this));
    ireq = Icy.get(url_opts, (function(_this) {
      return function(ice) {
        _this.icecast = ice;
        _this.icecast.once("end", function() {
          debug("Got end event");
          return _reconnect();
        });
        _this.icecast.once("close", function() {
          debug("Got close event");
          return _reconnect();
        });
        _this.icecast.on("metadata", function(data) {
          var meta;
          if (!_this._in_disconnect) {
            meta = Icy.parse(data);
            if (meta.StreamTitle) {
              _this.StreamTitle = meta.StreamTitle;
            }
            if (meta.StreamUrl) {
              _this.StreamUrl = meta.StreamUrl;
            }
            return _this.emit("metadata", {
              StreamTitle: _this.StreamTitle || "",
              StreamUrl: _this.StreamUrl || ""
            });
          }
        });
        _this.icecast.on("data", function(chunk) {
          return _this.parser.write(chunk);
        });
        _this.connected = true;
        _this.connected_at = new Date();
        return _this.emit("connect");
      };
    })(this));
    ireq.once("error", (function(_this) {
      return function(err) {
        _this._niceError(err);
        return _reconnect();
      };
    })(this));
    return this.on("_chunk", (function(_this) {
      return function(chunk) {
        _this.last_ts = chunk.ts;
        return _this.emit("data", chunk);
      };
    })(this));
  };

  ProxySource.prototype.disconnect = function() {
    var _ref, _ref1;
    this._in_disconnect = true;
    if (this.connected) {
      if ((_ref = this.icecast) != null) {
        _ref.removeAllListeners();
      }
      this.parser.removeAllListeners();
      this.removeAllListeners();
      this.icecast.end();
      this.parser = null;
      this.icecast = null;
      if ((_ref1 = this.log) != null) {
        _ref1.debug("ProxySource disconnected.");
      }
      return this.removeAllListeners();
    }
  };

  return ProxySource;

})(require("./base"));

//# sourceMappingURL=proxy.js.map
