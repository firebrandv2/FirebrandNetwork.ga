var Analytics, URL, elasticsearch, nconf, tz, winston, _,
  __hasProp = {}.hasOwnProperty,
  __extends = function(child, parent) { for (var key in parent) { if (__hasProp.call(parent, key)) child[key] = parent[key]; } function ctor() { this.constructor = child; } ctor.prototype = parent.prototype; child.prototype = new ctor(); child.__super__ = parent.prototype; return child; };

_ = require("underscore");

URL = require("url");

winston = require("winston");

tz = require("timezone");

nconf = require("nconf");

elasticsearch = require("elasticsearch");

module.exports = Analytics = (function() {
  function Analytics(opts, cb) {
    var es_uri;
    this.opts = opts;
    this._uri = URL.parse(this.opts.config.es_uri);
    this.log = this.opts.log;
    this._timeout_sec = Number(this.opts.config.finalize_secs);
    if (this.opts.redis) {
      this.redis = this.opts.redis.client;
    }
    es_uri = "http://" + this._uri.hostname + ":" + (this._uri.port || 9200);
    this.idx_prefix = this._uri.pathname.substr(1);
    this.log.debug("Connecting to Elasticsearch at " + es_uri + " with prefix of " + this.idx_prefix);
    this.es = new elasticsearch.Client({
      host: es_uri,
      apiVersion: "1.4",
      requestTimeout: this.opts.config.request_timeout || 30000
    });
    this.sessions = {};
    this.local = tz(require("timezone/zones"))(nconf.get("timezone") || "UTC");
    this._loadTemplates((function(_this) {
      return function(err) {
        if (err) {
          console.error(err);
          return typeof cb === "function" ? cb(err) : void 0;
        } else {
          return typeof cb === "function" ? cb(null, _this) : void 0;
        }
      };
    })(this));
    if (this.redis) {
      this.log.info("Analytics setting up Redis session sweeper");
      setInterval((function(_this) {
        return function() {
          return _this.redis.zrangebyscore("session-timeouts", 0, Math.floor(Number(new Date) / 1000), function(err, sessions) {
            var _sFunc;
            if (err) {
              return _this.log.error("Error fetching sessions to finalize: " + err);
            }
            _sFunc = function() {
              var s;
              if (s = sessions.shift()) {
                _this._triggerSession(s);
                return _sFunc();
              }
            };
            return _sFunc();
          });
        };
      })(this), 5 * 1000);
    }
  }

  Analytics.prototype._loadTemplates = function(cb) {
    var errors, obj, t, tmplt, _loaded, _ref, _results;
    errors = [];
    _loaded = _.after(Object.keys(Analytics.EStemplates).length, (function(_this) {
      return function() {
        if (errors.length > 0) {
          return cb(new Error("Failed to load index templates: " + (errors.join(" | "))));
        } else {
          return cb(null);
        }
      };
    })(this));
    _ref = Analytics.EStemplates;
    _results = [];
    for (t in _ref) {
      obj = _ref[t];
      this.log.info("Loading Elasticsearch mappings for " + this.idx_prefix + "-" + t);
      tmplt = _.extend({}, obj, {
        template: "" + this.idx_prefix + "-" + t + "-*"
      });
      _results.push(this.es.indices.putTemplate({
        name: "" + this.idx_prefix + "-" + t + "-template",
        body: tmplt
      }, (function(_this) {
        return function(err) {
          if (err) {
            errors.push(err);
          }
          return _loaded();
        };
      })(this)));
    }
    return _results;
  };

  Analytics.prototype._log = function(obj, cb) {
    var index_date, session_id, time, _ref, _ref1;
    session_id = null;
    if (!((_ref = obj.client) != null ? _ref.session_id : void 0)) {
      if (typeof cb === "function") {
        cb(new Error("Object does not contain a session ID"));
      }
      return false;
    }
    index_date = tz(obj.time, "%F");
    time = new Date(obj.time);
    if ((_ref1 = obj.client) != null ? _ref1.ip : void 0) {
      obj.client.ip = obj.client.ip.replace(/^::ffff:/, "");
    }
    return this._indicesForTimeRange("listens", time, (function(_this) {
      return function(err, idx) {
        switch (obj.type) {
          case "session_start":
            _this.es.index({
              index: idx[0],
              type: "start",
              body: {
                time: new Date(obj.time),
                session_id: obj.client.session_id,
                stream: obj.stream_group || obj.stream,
                client: obj.client
              }
            }, function(err) {
              if (err) {
                _this.log.error("ES write error: " + err);
                return typeof cb === "function" ? cb(err) : void 0;
              }
              return typeof cb === "function" ? cb(null) : void 0;
            });
            break;
          case "listen":
            _this._getStashedDurationFor(obj.client.session_id, obj.duration, function(err, dur) {
              return _this.es.index({
                index: idx[0],
                type: "listen",
                body: {
                  session_id: obj.client.session_id,
                  time: new Date(obj.time),
                  kbytes: obj.kbytes,
                  duration: obj.duration,
                  session_duration: dur,
                  stream: obj.stream,
                  client: obj.client,
                  offsetSeconds: obj.offsetSeconds,
                  contentTime: obj.contentTime
                }
              }, function(err) {
                if (err) {
                  _this.log.error("ES write error: " + err);
                  return typeof cb === "function" ? cb(err) : void 0;
                }
                return typeof cb === "function" ? cb(null) : void 0;
              });
            });
        }
        return _this._updateSessionTimerFor(obj.client.session_id, function(err) {});
      };
    })(this));
  };

  Analytics.prototype._getStashedDurationFor = function(session, duration, cb) {
    var key, s;
    if (this.redis) {
      key = "duration-" + session;
      this.redis.incrby(key, Math.round(duration), (function(_this) {
        return function(err, res) {
          return cb(err, res);
        };
      })(this));
      return this.redis.pexpire(key, 5 * 60 * 1000, (function(_this) {
        return function(err) {
          if (err) {
            return _this.log.error("Failed to set Redis TTL for " + key + ": " + err);
          }
        };
      })(this));
    } else {
      s = this._ensureMemorySession(session);
      s.duration += duration;
      return cb(null, s.duration);
    }
  };

  Analytics.prototype._updateSessionTimerFor = function(session, cb) {
    var s, timeout_at;
    if (this._timeout_sec <= 0) {
      return cb(null);
    }
    if (this.redis) {
      timeout_at = (Number(new Date) / 1000) + this._timeout_sec;
      return this.redis.zadd("session-timeouts", timeout_at, session, (function(_this) {
        return function(err) {
          return cb(err);
        };
      })(this));
    } else {
      s = this._ensureMemorySession(session);
      if (s.timeout) {
        clearTimeout(s.timeout);
      }
      s.timeout = setTimeout((function(_this) {
        return function() {
          return _this._triggerSession(session);
        };
      })(this), this._timeout_sec * 1000);
      return cb(null);
    }
  };

  Analytics.prototype._scrubSessionFor = function(session, cb) {
    var s;
    if (this.redis) {
      return this.redis.zrem("session-timeouts", session, (function(_this) {
        return function(err) {
          if (err) {
            return cb(err);
          }
          return _this.redis.del("duration-" + session, function(err) {
            return cb(err);
          });
        };
      })(this));
    } else {
      s = this._ensureMemorySession(session);
      if (s.timeout) {
        clearTimeout(s.timeout);
      }
      delete this.sessions[session];
      return cb(null);
    }
  };

  Analytics.prototype._ensureMemorySession = function(session) {
    var _base;
    return (_base = this.sessions)[session] || (_base[session] = {
      duration: 0,
      last_seen_at: Number(new Date()),
      timeout: null
    });
  };

  Analytics.prototype._triggerSession = function(session) {
    return this._scrubSessionFor(session, (function(_this) {
      return function(err) {
        if (err) {
          return _this.log.error("Error cleaning session cache: " + err);
        }
        return _this._finalizeSession(session, function(err, obj) {
          if (err) {
            return _this.log.error("Error assembling session: " + err);
          }
          if (obj) {
            return _this._storeSession(obj, function(err) {
              if (err) {
                return _this.log.error("Error writing session: " + err);
              }
            });
          }
        });
      };
    })(this));
  };

  Analytics.prototype._finalizeSession = function(id, cb) {
    var session;
    this.log.silly("Finalizing session for " + id);
    session = {};
    return this._selectPreviousSession(id, (function(_this) {
      return function(err, ts) {
        if (err) {
          _this.log.error(err);
          return typeof cb === "function" ? cb(err) : void 0;
        }
        return _this._selectSessionStart(id, function(err, start) {
          if (err) {
            _this.log.error(err);
            return cb(err);
          }
          if (!start) {
            _this.log.debug("Attempt to finalize invalid session. No start event for " + id + ".");
            return cb(null, false);
          }
          return _this._selectListenTotals(id, ts, function(err, totals) {
            if (err) {
              _this.log.error(err);
              return typeof cb === "function" ? cb(err) : void 0;
            }
            if (!totals) {
              return cb(null, false);
            }
            session = {
              session_id: id,
              output: start.output,
              stream: start.stream,
              time: totals.last_listen,
              start_time: ts || start.time,
              client: start.client,
              kbytes: totals.kbytes,
              duration: totals.duration,
              connected: (Number(totals.last_listen) - Number(ts || start.time)) / 1000
            };
            return cb(null, session);
          });
        });
      };
    })(this));
  };

  Analytics.prototype._storeSession = function(session, cb) {
    var index_date;
    index_date = tz(session.time, "%F");
    return this.es.index({
      index: "" + this.idx_prefix + "-sessions-" + index_date,
      type: "session",
      body: session
    }, (function(_this) {
      return function(err) {
        return cb(err);
      };
    })(this));
  };

  Analytics.prototype._selectSessionStart = function(id, cb) {
    var body;
    body = {
      query: {
        constant_score: {
          filter: {
            term: {
              "session_id": id
            }
          }
        }
      },
      sort: {
        time: {
          order: "desc"
        }
      },
      size: 1
    };
    return this._indicesForTimeRange("listens", new Date(), "-72 hours", (function(_this) {
      return function(err, indices) {
        return _this.es.search({
          type: "start",
          body: body,
          index: indices,
          ignoreUnavailable: true
        }, function(err, res) {
          if (err) {
            return cb(new Error("Error querying session start for " + id + ": " + err));
          }
          if (res.hits.hits.length > 0) {
            return cb(null, _.extend({}, res.hits.hits[0]._source, {
              time: new Date(res.hits.hits[0]._source.time)
            }));
          } else {
            return cb(null, null);
          }
        });
      };
    })(this));
  };

  Analytics.prototype._selectPreviousSession = function(id, cb) {
    var body;
    body = {
      query: {
        constant_score: {
          filter: {
            term: {
              "session_id": id
            }
          }
        }
      },
      sort: {
        time: {
          order: "desc"
        }
      },
      size: 1
    };
    return this._indicesForTimeRange("sessions", new Date(), "-72 hours", (function(_this) {
      return function(err, indices) {
        return _this.es.search({
          type: "session",
          body: body,
          index: indices,
          ignoreUnavailable: true
        }, function(err, res) {
          if (err) {
            return cb(new Error("Error querying for old session " + id + ": " + err));
          }
          if (res.hits.hits.length === 0) {
            return cb(null, null);
          } else {
            return cb(null, new Date(res.hits.hits[0]._source.time));
          }
        });
      };
    })(this));
  };

  Analytics.prototype._selectListenTotals = function(id, ts, cb) {
    var body, filter;
    filter = ts ? {
      "and": {
        filters: [
          {
            range: {
              time: {
                gt: ts
              }
            }
          }, {
            term: {
              session_id: id
            }
          }
        ]
      }
    } : {
      term: {
        session_id: id
      }
    };
    body = {
      query: {
        constant_score: {
          filter: filter
        }
      },
      aggs: {
        duration: {
          sum: {
            field: "duration"
          }
        },
        kbytes: {
          sum: {
            field: "kbytes"
          }
        },
        last_listen: {
          max: {
            field: "time"
          }
        }
      }
    };
    return this._indicesForTimeRange("listens", new Date(), ts || "-72 hours", (function(_this) {
      return function(err, indices) {
        return _this.es.search({
          type: "listen",
          index: indices,
          body: body,
          ignoreUnavailable: true
        }, function(err, res) {
          if (err) {
            return cb(new Error("Error querying listens to finalize session " + id + ": " + err));
          }
          if (res.hits.total > 0) {
            return cb(null, {
              requests: res.hits.total,
              duration: res.aggregations.duration.value,
              kbytes: res.aggregations.kbytes.value,
              last_listen: new Date(res.aggregations.last_listen.value)
            });
          } else {
            return cb(null, null);
          }
        });
      };
    })(this));
  };

  Analytics.prototype._indicesForTimeRange = function(idx, start, end, cb) {
    var indices, s;
    if (_.isFunction(end)) {
      cb = end;
      end = null;
    }
    start = this.local(start);
    if (_.isString(end) && end[0] === "-") {
      end = this.local(start, end);
    }
    indices = [];
    if (end) {
      end = this.local(end);
      s = start;
      while (true) {
        s = this.local(s, "-1 day");
        if (s < end) {
          break;
        }
        indices.push("" + this.idx_prefix + "-" + idx + "-" + (this.local(s, "%F")));
      }
    }
    indices.unshift("" + this.idx_prefix + "-" + idx + "-" + (this.local(start, "%F")));
    return cb(null, _.uniq(indices));
  };

  Analytics.prototype.countListeners = function(cb) {
    var body;
    body = {
      query: {
        constant_score: {
          filter: {
            range: {
              time: {
                gt: "now-15m"
              }
            }
          }
        }
      },
      size: 0,
      aggs: {
        listeners_by_minute: {
          date_histogram: {
            field: "time",
            interval: "minute"
          },
          aggs: {
            duration: {
              sum: {
                field: "duration"
              }
            },
            sessions: {
              cardinality: {
                field: "session_id"
              }
            },
            streams: {
              terms: {
                field: "stream",
                size: 5
              }
            }
          }
        }
      }
    };
    return this._indicesForTimeRange("listens", new Date(), "-15 minutes", (function(_this) {
      return function(err, indices) {
        return _this.es.search({
          index: indices,
          type: "listen",
          body: body,
          ignoreUnavailable: true
        }, function(err, res) {
          var obj, sobj, streams, times, _i, _j, _len, _len1, _ref, _ref1;
          if (err) {
            return cb(new Error("Failed to query listeners: " + err));
          }
          times = [];
          _ref = res.aggregations.listeners_by_minute.buckets;
          for (_i = 0, _len = _ref.length; _i < _len; _i++) {
            obj = _ref[_i];
            streams = {};
            _ref1 = obj.streams.buckets;
            for (_j = 0, _len1 = _ref1.length; _j < _len1; _j++) {
              sobj = _ref1[_j];
              streams[sobj.key] = sobj.doc_count;
            }
            times.unshift({
              time: _this.local(new Date(obj.key), "%F %T%^z"),
              requests: obj.doc_count,
              avg_listeners: Math.round(obj.duration.value / 60),
              sessions: obj.sessions.value,
              requests_by_stream: streams
            });
          }
          return cb(null, times);
        });
      };
    })(this));
  };

  Analytics.LogTransport = (function(_super) {
    __extends(LogTransport, _super);

    LogTransport.prototype.name = "analytics";

    function LogTransport(a) {
      this.a = a;
      LogTransport.__super__.constructor.call(this, {
        level: "interaction"
      });
    }

    LogTransport.prototype.log = function(level, msg, meta, cb) {
      if (level === "interaction") {
        this.a._log(meta);
        return typeof cb === "function" ? cb() : void 0;
      }
    };

    return LogTransport;

  })(winston.Transport);

  Analytics.ESobjcore = {
    time: {
      type: "date",
      format: "date_time",
      doc_values: true
    },
    stream: {
      type: "string",
      index: "not_analyzed",
      doc_values: true
    },
    session_id: {
      type: "string",
      index: "not_analyzed",
      doc_values: true
    },
    client: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          index: "not_analyzed",
          doc_values: true
        },
        user_id: {
          type: "string",
          index: "not_analyzed",
          doc_values: true
        },
        output: {
          type: "string",
          index: "not_analyzed",
          doc_values: true
        },
        ip: {
          type: "string",
          index: "not_analyzed",
          doc_values: true
        },
        ua: {
          type: "string",
          index: "not_analyzed",
          doc_values: true
        },
        path: {
          type: "string",
          index: "not_analyzed",
          doc_values: true
        }
      }
    }
  };

  Analytics.EStemplates = {
    sessions: {
      settings: {
        index: {
          number_of_shards: 3,
          number_of_replicas: 1
        }
      },
      mappings: {
        session: {
          "_all": {
            enabled: false
          },
          properties: _.extend({}, Analytics.ESobjcore, {
            duration: {
              type: "float"
            },
            kbytes: {
              type: "long"
            },
            ips: {
              type: "string",
              index: "not_analyzed",
              index_name: "ip",
              doc_values: true
            }
          })
        }
      }
    },
    listens: {
      settings: {
        index: {
          number_of_shards: 3,
          number_of_replicas: 1
        }
      },
      mappings: {
        start: {
          "_all": {
            enabled: false
          },
          properties: _.extend({}, Analytics.ESobjcore)
        },
        listen: {
          "_all": {
            enabled: false
          },
          properties: _.extend({}, Analytics.ESobjcore, {
            duration: {
              type: "float"
            },
            kbytes: {
              type: "long"
            },
            offsetSeconds: {
              type: "integer",
              doc_values: true
            },
            contentTime: {
              type: "date",
              format: "date_time",
              doc_values: true
            }
          })
        }
      }
    }
  };

  return Analytics;

})();

//# sourceMappingURL=analytics.js.map
