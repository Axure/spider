var request = require('request')
  , fs = require('fs')
  , sys = require('sys')
  , path = require('path')
  , jsdom = require('jsdom')
  , util = require('util')
  , urlParse = require('url').parse
  , urlResolve = require('url').resolve
  , routes = require('routes')
  , events = require('events')
  , util = require('util')
  , cookiejar = require('cookiejar')
  ;

var headers = 
  { 'accept': "application/xml,application/xhtml+xml,text/html;q=0.9,text/plain;q=0.8,image/png,*/*;q=0.5"
  , 'accept-language': 'en-US,en;q=0.8'
  , 'accept-charset':  'ISO-8859-1,utf-8;q=0.7,*;q=0.3'
  }

var firefox = 'Mozilla/5.0 (Macintosh; U; Intel Mac OS X 10_6_4; en-US) ' +
              'AppleWebKit/534.7 (KHTML, like Gecko) Chrome/7.0.517.41 Safari/534.7'

  
var jqueryFilename = path.join(__dirname, 'jquery.js')
  , jquery = fs.readFileSync(jqueryFilename).toString()
  ;

var copy = function (obj) {
  var n = {}
  for (i in obj) {
    n[i] = obj[i];
  }
  return n
}

jsdom.defaultDocumentFeatures = 
  { FetchExternalResources   : []
  , ProcessExternalResources : false
  , MutationEvents           : false
  , QuerySelector            : false
  }
  
var Context = process.binding('evals').Context,
    Script = process.binding('evals').Script;
jqueryify = function(window, document) {
  var filename = jqueryFilename
    , document = window.document
    ;
  if (window) {
    var ctx = window.__scriptContext;
    if (!ctx) {
      window.__scriptContext = ctx = new Context();
      ctx.__proto__ = window;
    }
    var tracelimitbak = Error.stackTraceLimit;
    Error.stackTraceLimit = 100;
    try {
      Script.runInContext(jquery, ctx, filename);
    }
    catch(e) {
      document.trigger(
        'error', 'Running ' + filename + ' failed.', 
        {error: e, filename: filename}
      );
    }
    Error.stackTraceLimit = tracelimitbak;
  }
};

var debug = 1
  , info = 50
  , error = 100
  ;
  
var isUrl = /^https?:/;  
  
var logLevels = {debug:debug, info:info, error:error, 1:'debug', 50:'info', 100:'error'}

function MemoryCache () {
  this.cache = {};
}
MemoryCache.prototype.get = function (url, cb) {
  if (!this.cache[url]) return cb(null);
  cb({headers:this.cache[url].headers, body:this.cache[url].body.toString()});
}
MemoryCache.prototype.set = function (url, headers, body) {
  this.cache[url] = {headers:headers, body:new Buffer(body)};
}
MemoryCache.prototype.getHeaders = function (url, cb) {
  if (!this.cache[url]) return cb(null);
  cb(this.cache[url].headers);
}

function NoCache () {};
NoCache.prototype.get = function (url, cb) { cb(null) };
NoCache.prototype.getHeaders = function (url, cb) {cb(null)};
NoCache.prototype.set = function (url, headers, body) {};

function Spider (options) {
  this.maxSockets = options.maxSockets || 4;
  this.userAgent = options.userAgent || firefox;
  this.cache = options.cache || new NoCache();
  this.pool = options.pool || {maxSockets: options.maxSockets};
  this.options = options;
  this.currentUrl = null;
  this.routers = {};
  this.urls = [];
  this.jar = cookiejar.CookieJar();
}
util.inherits(Spider, events.EventEmitter)
Spider.prototype.get = function (url, referer) {
  var self = this
    , h = copy(headers)
    ;
  referer = referer || this.currentUrl;  
  
  url = url.slice(0, (url.indexOf('#') === -1) ? url.length : url.indexOf('#'))
  
  if (this.urls.indexOf(url) !== -1) {
    // Already handled this request
    this.emit('log', debug, 'Already received one get request for '+url+'. skipping.')
    return this;
  } 
  this.urls.push(url);
  
  var u = urlParse(url);
  if (!this.routers[u.host]) {
    this.emit('log', debug, 'No routes for host: '+u.host+'. skipping.')
    return this;
  }
  if (!this.routers[u.host].match(u.href.slice(u.href.indexOf(u.host)+u.host.length))) {
    this.emit('log', debug, 'No routes for path '+u.href.slice(u.href.indexOf(u.host)+u.host.length)+'. skipping.')
    return this;
  }

  if (referer) h.referer = referer;
  h['user-agent'] = this.userAgent;
  
  this.cache.getHeaders(url, function (c) {
    if (c) {
      if (c['last-modifed']) {
        h['if-modified-since'] = c['last-modified'];
      }
      if (c.etag) {
        h['if-none-match'] = c.etag;
      }
    }
    
    var cookies = self.jar.getCookies(cookiejar.CookieAccessInfo(u.host, u.pathname));
    console.log('log', debug, 'cookies = '+cookies);
    if (cookies) {
      h.cookie = cookies.join(";").replace(/\s+/g,"");
      console.log("cookieheader "+h.cookie);
//      h.cookie="worksafe=0;cookid=529633;cookpass=40b12aa309f613a5c5d283d6e2d54abd;user_logged_in=1";
    }
    
    request.get({url:url, headers:h, pool:self.pool}, function (e, resp, body) {
      self.emit('log', debug, 'Response received for '+url+'.')
      if (resp.statusCode === 304) {
        self.cache.get(url, function (c_) {
          self._handler(url, referer, {fromCache:true, headers:c_.headers, body:c_.body})
        });
        return;
      } else if (resp.statusCode !== 200) {
        self.emit('log', debug, 'Request did not return 200. '+url);
        return;
      } else if (!resp.headers['content-type'] || resp.headers['content-type'].indexOf('html') === -1) {
        self.emit('log', debug, 'Content-Type does not match. '+url);
        return;
      }
      if (resp.headers['set-cookie']) {
        self.jar.setCookies(resp.headers['set-cookie'])
      }
      self.cache.set(url, resp.headers, body);
      self._handler(url, referer, {fromCache:false, headers:resp.headers, body:body});
    })
  });
  return this;
}
Spider.prototype.route = function (hosts, pattern, cb) {
  var self = this;
  if (typeof hosts === 'string') {
    hosts = [hosts];
  }
  hosts.forEach(function (host) {
    if (!self.routers[host]) self.routers[host] = new routes.Router();
    self.routers[host].addRoute(pattern, cb);
  })
  return self;
}
Spider.prototype._handler = function (url, referer, response) {
  var u = urlParse(url)
    , self = this
    ;
  if (this.routers[u.host]) {
    var r = this.routers[u.host].match(u.href.slice(u.href.indexOf(u.host)+u.host.length));
    r.spider = this;
    r.response = response
    r.url = u;
    var window = jsdom.jsdom(response.body).createWindow();
    jqueryify(window);
    window.$.fn.spider = function () {
      this.each(function () {
        var h = window.$(this).attr('href');
        if (!isUrl.test(h)) {
          h = urlResolve(url, h);
        }
        self.get(h, url);
      })
    }
    
    this.currentUrl = url;
    if (jsdom.defaultDocumentFeatures.ProcessExternalResources) {
      $(function () { r.fn.call(r, window, window.$); })
    } else {
      r.fn.call(r, window, window.$);
    }
    this.currentUrl = null;
  }
}
Spider.prototype.log = function (level) {
  if (typeof level === 'string') level = logLevels[level];
  this.on('log', function (l, text) {
    if (l >= level) {
      console.log('['+(logLevels[l] || l)+']', text)
    }
  })
  return this;
}

function ZombieSpider (options) {
  var zombie = require('zombie');
  this.browser = new zombie.Browser({ debug: options });
  if (typeof options.runScripts !== 'undefined') {
    options.runScripts = false;
  }
  this.browser.runScripts = options.runScripts;
  
  this.get = function () {};
}
util.inherits(ZombieSpider, Spider);

module.exports = function (options) {return new Spider(options || {})}
module.exports.jsdom = jsdom;


