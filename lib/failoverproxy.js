"use strict";

var
	fs				= require('fs'),
	http			= require('http'),
	https			= require('https'),
	crypto			= require('crypto'),
	url				= require('url'),

	cacheDrivers	= { };

/*
  TODO:
  	- Cache support
  	- Support for reloading configuration
  	- Support for setting number of agent connections and warning when connection number reach the limit
 */


// Object constructor

module.exports = function(opts){

	var
		self	= this,
		config	= opts;


	// Internal stuff
	self.DEBUG					= opts.DEBUG;
	self.opts					= opts;
	self.confs					= [];
	self.confIdx				= -1;
	self.config					= null;

	self.stats					= { failover: 0, cache: 0, failed: 0 };
	self.nextID					= 0;

	self.backends				= [];
	self.backendStatus			= {};
	self.currentBackend			= null;
	self.selectBackend			= null;
	self.backendWatchInterval	= 1000;
	self.httpTimeout			= 5000;
	self.httpTestTimeout		= 1000;
	self.cacheWriting			= {};

	// Methods
	self.startServer			= startServer;
	self.registerCacheDriver	= registerCacheDriver;
	self._loadConfiguration		= _loadConfiguration;
	self._loadCacheDriver		= _loadCacheDriver;
	self._readConfFile			= _readConfFile;
	self._buildInternals		= _buildInternals;
	self._selectDefaultBackend	= _selectDefaultBackend;
	self._switchBackend			= _switchBackend;
	self._jumpBackend			= _jumpBackend;
	self._handleRequest			= _handleRequest;
	self._handleRequestProxy	= _handleRequestProxy;
	self._handleRequestCache	= _handleRequestCache;
	self._backendDown			= _backendDown;
	self._backendUp				= _backendUp;
	self._watchBackend			= _watchBackend;
	self._httpProxy				= _httpProxy;
	self._httpTest				= _httpTest;
	self._cacheResult			= _cacheResult;
	self._sendError				= _sendError;
	self._log					= _log;
	self._debug					= _debug;

	// Register FS cache driver
	self.registerCacheDriver("fs",{store: _cacheStoreFS, retrieve: _cacheRetrieveFS, validate: _cacheValidateFS, id: _cacheIDFS});

	// Load configuration
	self._loadConfiguration();

	// Build internals
	self._buildInternals();

	// Select the default backend
	self.currentBackend = self._selectDefaultBackend();
	if ( self.currentBackend ) {
		self.currentBackend.default = true;
		self._debug("Starting with backend #"+self.currentBackend.idx+" as default backend");
	}
	else
		self._debug("WARN:\tAll the backends are starting DOWN.");

	// Start the server
	self.startServer();

};

function _loadConfiguration(file) {

	var
		self = this,
		opts = self.opts,
		configFileOpts,
		config = {};

	if ( !file )
		file = opts.configFile;

	configFileOpts = self._readConfFile(file);
	if ( configFileOpts && configFileOpts )
		config = _merge(config,configFileOpts);

	// Add a new configuration
	self.confs.push(config);
	self.confIdx++;
	self.config = self.confs[self.confIdx];

}

function _loadCacheDriver(driver) {

	if ( cacheDrivers[driver] )
		return false;

	try {
		require("failoverproxy-"+driver);
	}
	catch(ex) {
		throw new Error("Error loading cache driver '"+driver+"': "+ex.toString());
	}
	if ( !cacheDrivers[driver] )
		throw new Error("Unsupported cache driver '"+driver+"'. Make sure you have installed the cache module (failoverproxy-"+driver+")");

	return true;

}

function _readConfFile(file,handler) {

	var
		self = this,
		data,
		conf;

	// Read the file
	try {
		data = fs.readFileSync(file);
	}
	catch(ex) {
		self._debug("Error reading configuration file '"+file+"': ",ex);
		throw ex;
	}

	// Parse the configuration file
	try {
		eval("conf = "+data.toString());
	}
	catch(ex){
		self._debug("Error parsing configuration file: ",ex);
		throw ex;
	}

	return conf;
}

function _buildInternals() {

	var
		self = this,
		opts = self.config,
		cacheBEs = 0,
		idx = 0;

	// Local binding address and port
	self.localAddress	= opts.localAddress	|| "0.0.0.0";
	self.localPort		= opts.localPort	|| 8080;

	// Is the cache active?
	self.cacheIsActive	= false;

	// Backends
	if ( !opts.backends )
		throw new Error("No backends list on the configuration");
	if ( !(opts.backends instanceof Array) )
		throw new Error("Expecting an array of backends on the 'backends' configuration");
	self.backends = [];
	opts.backends.forEach(function(be){
		var
			beObj;

		// String backends
		if ( typeof be == "string" ) {
			if ( be === "cache" ) {
				if ( !opts.cache )
					throw new Error("Using a cache backend without 'cache' configuration");
				if ( typeof opts.cache != "object" )
					throw new Error("Expecting an object as 'cache' configuration and got a "+typeof(opts.cache));
				if ( !opts.cache.driver )
					opts.cache.driver = "fs";
				self._loadCacheDriver(opts.cache.driver);
				opts.cache.driver = cacheDrivers[opts.cache.driver];

				// Defaults
				if ( typeof opts.cache.expireTime == "undefined" || (typeof opts.cache.expireTime != "number" && opts.cache.expireTime !== 'never') )
					opts.cache.expireTime = 600000;	// 10 minutes
				if ( !opts.cache.cacheKey )
					opts.cache.cacheKey = function(req){return req.url};

				// Validate the cache backend with the cache driver
				opts.cache.driver.validate(opts.cache);

				beObj = _merge(opts.cache||{},{type:"cache"});
				self.cacheIsActive = true;

				// Generate the backend ID
				beObj.id = "cache@"+opts.cache.driver.id(beObj);
			}
			else if ( be.match(/^https?:\/\//) ) {
				var
					beURL = require('url').parse(be);

				beObj = {
					type:	"server",
					proto:	beURL.protocol,
					host:	beURL.hostname,
					port:	beURL.port || 80,
					prefix:	beURL.path
				};
				beObj.id = beObj.proto+"://"+beObj.host+":"+beObj.port+beObj.prefix;
			}
			else
				throw new Error("Invalid string '"+be+"' as a backend");
		}

		// Object backends
		else if ( typeof be == "object" ) {
			if ( !be.type && be.host )
				be.type = "server";
			if ( be.type === "server" ) {
				beObj = _merge(be,{type: "server"});
				if ( !beObj.host )
					throw new Error("Found a backend without host. Aborting");
				if ( !beObj.proto )
					beObj.proto = "http";
				if ( !beObj.port )
					beObj.port = 80;
				if ( !beObj.prefix )
					beObj.prefix = "/";
				beObj.id = beObj.proto+"://"+beObj.host+":"+beObj.port+beObj.prefix;
			}
			else if ( be.type === "cache" || be.path ) {
				beObj = _merge(be,{type:"cache",id:"cache@"+opts.cache.path});
				if ( !beObj.driver )
					beObj.driver = "fs";
				self._loadCacheDriver(beObj.driver);
				beObj.driver = cacheDrivers[beObj.driver];

				// Defaults
				if ( typeof beObj.expireTime == "undefined" || (typeof beObj.expireTime != "number" && beObj.expireTime !== 'never') )
					beObj.expireTime = 600000; // 10 minutes
				if ( !beObj.keyGenerator )
					beObj.keyGenerator = function(req){return req.url};

				// Validate the cache backend with the cache driver
				opts.cache.driver.validate(beObj);

				// Generate the backend ID
				beObj.id = "cache@"+opts.cache.driver.id(beObj);

				self.cacheIsActive = true;
			}
		}

		// Add the backend
		if ( beObj.type ) {
			beObj.idx = idx++;
			beObj.status = self.backendStatus[beObj.id] || 'up';
			self.backendStatus[beObj.id] = beObj.status;
			self.backends.push(beObj);
		}
	});
	if ( self.backends.length == 0 )
		throw new Error("No configured backends");

	// The backend selector
	self.selectBackend = opts.selectBackend || function(backends) { return backends[0]; };

	// Backend watch interval
	if ( opts.backendWatchInterval && typeof opts.backendWatchInterval == "number" )
		self.backendWatchInterval = opts.backendWatchInterval;

	// HTTP timeouts
	if ( opts.httpTestTimeout && typeof opts.httpTestTimeout == "number" )
		self.httpTestTimeout = opts.httpTestTimeout;
	if ( opts.httpTimeout && typeof opts.httpTimeout == "number" )
		self.httpTimeout = opts.httpTimeout;

	// Hooks
	if ( opts.requestPreProxy && typeof opts.requestPreProxy == "function" )
		self.requestPreProxy = opts.requestPreProxy;

}

// Find the default backend
function _selectDefaultBackend() {

	var
		self = this;

	// Find the default backend
	for ( var x = 0 ; x < self.backends.length ; x++ ) {
		var be = self.backends[x];
		if ( be.default && be.status === 'up' )
			return be;
	}

	// Return the first healthy backend
	for ( var x = 0 ; x < self.backends.length ; x++ ) {
		var be = self.backends[x];
		if ( be.status === 'up' )
			return be;
	}

	return null;

}


// Start HTTP server
function startServer(){

	var
		self = this,
		curRemoteURL = self.remoteURL;

	http.createServer(function(req,res) {

		// X-Forwarded-For
		req.headers['x-forwarded-for'] = req.connection.remoteAddress || (req.client && req.client._peername) ? req.client._peername.address : "0.0.0.0";

		// Request connection data and ID
		req.xConnectDate = new Date();
		req.xRequestID = (new Date()).getTime() + "." + self.nextID++;
		if ( self.nextID === 2147483647 )
			self.nextID = 0;
		req.jumpedBackends = {};

		// Handle request
		req.currentBackend = self.currentBackend;
		self._handleRequest(req,res);

	}).listen(self.localPort, self.localAddress);
	self._debug("Listening on "+self.localAddress+":"+self.localPort);

}

// Handle a request
function _handleRequest(req,res){

	var
		self = this;

	if ( !req.currentBackend ) {
		this.stats.failed++;
//		this._debug("WARN:\tAll backends are down!! Can't handle request. #503.1")
		return self._sendError(req,res,503.1);
	}

	// Handle the request
	return (req.currentBackend.type === "cache") ? this._handleRequestCache(req,res) : this._handleRequestProxy(req,res);
}

function _handleRequestCache(req,res) {

	var
		self = this,
		cacheKey = req.currentBackend.keyGenerator(req) || "NO_HASH";

	// Retrieve the item from cache
	return req.currentBackend.driver.retrieve.apply(self,[cacheKey,req.currentBackend,function(err,data){
		if ( err ) {
			self._debug("ERROR:\tError getting item '"+cacheKey+"' from cache. Switching request to next backend. Error: ",err);
			return self._jumpBackend(req,res);
		}

		if ( data == null ) {
			self._debug("INFO:\tItem '"+cacheKey+"' not cached. Switching request to next backend...");
			return self._jumpBackend(req,res);
		}

		// Decode data
		var
			headSize = _sizeDataToNum(data),
			serHeaders = data.slice(4,headSize+4).toString(),
			body = data.slice(4+headSize,data.length),
			statusCode = serHeaders.substr(0,3),
			headers;

		try {
			headers = JSON.parse(serHeaders.substr(4,serHeaders.length-4));
		}
		catch(ex){
			self._debug("ERROR:\tError parsing headers from cache items: ",ex);
			self._debug("INFO:\tSwitching request to next backend...");
			return self._jumpBackend(req,res);
		}

		// Write on x-cache header
		headers['x-cache'] = "From cache";

		// Send the answer
		self._debug("INFO:\tBackend #"+req.currentBackend.idx+": Answering from cache with status "+statusCode+" and a body of "+body.length+" bytes");
//		console.log("HEADERS: ",headers);
//		console.log("BODY: ",body.toString());
		res.writeHead(statusCode,headers);
		res.end(body);

	}]);

}

function _handleRequestProxy(req,res) {

	var
		self = this;

	// Proxy
	self._debug("INFO:\tProxying "+req.url+" to "+req.currentBackend.id);
	self._httpProxy(req,res,req.currentBackend,false,function(err,pres,answer){
		if ( err ) {
			self._debug("ERROR:\tError proxying request to server ["+req.currentBackend.idx+"]: ",err);
			self._backendDown(req.currentBackend);
			self._switchBackend();
			req.currentBackend = self.currentBackend;
			return setImmediate(function(){ self._handleRequest(req,res); });
		}

		self._backendUp(req.currentBackend);
		self._log(req,res,req.currentBackend,pres.statusCode,pres.transferredBytes,pres.firstByte);
		self._cacheResult(req,answer);
		if ( !req.currentBackend.default )
			self.stats.failover++;
	});

}

// Declare that server is up
function _backendUp(be){

	var
		self = this;

	if ( be.status === 'up' )
		return;

	var
		serverName = be.default ? "Default backend" : "Backend #"+be.idx;

	be.status = 'up';
	self._debug("INFO:\t"+serverName+" is up!");

	self._switchBackend();

}

// Declare that server is down
function _backendDown(be){

	var
		self = this;

	if ( be.status === 'down' )
		return;

	be.status = 'down';
	if ( be.type == "server" )
		self._watchBackend(be);
	self._debug("INFO:\tBackend #"+be.idx+" is down!");

	self._switchBackend();

}

// Switch backend (or not..)
function _switchBackend() {

	var
		self = this,
		healthyBackends = [],
		prevBackend = self.currentBackend,
		serverName;

	// Select the new current server
	self.backends.forEach(function(be){
		if ( be.status === 'up' )
			healthyBackends.push(be);
	});

	// Elect a new backend
	self.currentBackend = self.selectBackend(healthyBackends);
	if ( !self.currentBackend ) {
		self._debug("WARN:\tNo healthy backends left!! Everything is DOWN!")
	}
	else if ( !prevBackend && self.currentBackend ) {
		self._debug("INFO:\tUsing now Backend #"+self.currentBackend.idx);
	}
	else if ( prevBackend && prevBackend.id !== self.currentBackend.id ) {
		serverName = self.currentBackend.default ? "Default backend" : "Backend #"+self.currentBackend.idx;
		self._debug("INFO:\tSwitched to "+serverName+"!");
	}

}

// Switch a request to other backend
function _jumpBackend(req,res) {

	var
		self = this,
		usableBackends = [];

	// Jump current backend
	req.jumpedBackends[req.currentBackend.idx] = true;

	// Select the new current server
	self.backends.forEach(function(be){
		if ( be.status === 'up' && !req.jumpedBackends[be.idx] )
			usableBackends.push(be);
	});

	// Elect a new backend
	req.currentBackend = self.selectBackend(usableBackends,req);
	if ( !req.currentBackend ) {
		self._debug("WARN:\tNo healthy backends left for current request.");
	}

	return setImmediate(function(){ self._handleRequest(req,res); });

}

// Watch if a backend comes up
function _watchBackend(be) {

	var
		self = this,
		serverName;

	serverName = be.default ? "Default backend" : "Backend #"+be.idx;

	// Send HEAD request periodically
	self._httpTest(be,function(err,ok){
		if ( err )
			return setTimeout(function(){ self._watchBackend(be); },self.backendWatchInterval);

		return self._backendUp(be);
	});

}

// Test a server
function _httpTest(be,handler) {

	var
		self = this,
		httpMod = (be.proto == "https" ? https : http),
		req,
		tto;

	req = httpMod.request({host: be.host, port: be.port, method: "HEAD", headers: {host: be.host}, path: (be.prefix||"/")});
	req.on('response',function(res){
		if ( tto )
			clearTimeout(tto);
		res.on('end',function(){});
		return handler(null,res);
	});
	req.on('error',function(err){
		if ( tto )
			clearTimeout(tto);
		req.abort();
		return handler(err,null);
	});
	req.end();
	tto = setTimeout(function(){
		req.abort();
	},self.httpTestTimeout);

}

// Proxy a request
function _httpProxy(req,res,be,cacheResults,handler) {

	var
		self = this,
		httpMod = (be.proto == "https" ? https : http),
		preq,
		totalSize = 0,
		firstByte = null,
		fired = false,
		answerToCache;

	if ( be.prefix && be.prefix !== "/" )
		req.url = be.prefix + req.url;

	// Has a pre-proxy hook? Run it!
	if ( self.requestPreProxy )
		self.requestPreProxy(req,be);

//	req.headers['host'] = be.host;
	req.headers['connection'] = 'Keep-Alive';

	preq = httpMod.request({host: be.host, port: be.port, method: req.method, headers: req.headers, path: req.url});
	preq.on('response',function(pres){
		pres.headers['x-cache'] = "From proxy";
		res.writeHead(pres.statusCode, pres.headers);
		pres.on('data',function(chunk) {
			if ( firstByte == null )
				firstByte = new Date();
			res.write(chunk, 'binary');
			totalSize += chunk.length;
			if ( self.cacheIsActive ) {
				if ( !answerToCache ) {
					var headersBuf = new Buffer(pres.statusCode+","+JSON.stringify(pres.headers));
					answerToCache = Buffer.concat([_sizeNumToData(headersBuf.length),headersBuf,chunk]);
				}
				else
					answerToCache = Buffer.concat([answerToCache,chunk]);
			}
		});
		pres.on('end',function(){
			pres.firstByte = firstByte ? firstByte : new Date();
			pres.transferredBytes = totalSize;
			res.end();
			fired = true;
			if ( handler )
				handler(null,pres,answerToCache);
		});
	});
	preq.on('error',function(e){
		if ( fired )
			return;
		fired = true;
		if ( handler )
			return handler(e,null);
		res.writeHead(503,{'content-type':'text/plain; charset=UTF-8'});
		res.end('Gateway error: '+e.toString());
	});
	if ( typeof(req.POSTContent) == "undefined" ) {
		req.on('data',function(chunk) {
			preq.write(chunk, 'binary');
			req._POSTContent = (req._POSTContent == null) ? bufferConcat([chunk]) : bufferConcat([req._POSTContent,chunk]);
		});
		req.on('end', function() {
			req.POSTContent = (typeof(req._POSTContent) == "undefined") ? null : req._POSTContent;
			preq.end();
		});
	}
	else
		preq.end(req.POSTContent);

	// HTTP timeout
	setTimeout(function(){
		if ( fired || firstByte )
			return;
		fired = true;
		preq.abort();
		return handler(new Error("HTTP proxy timeout"),null);
	},self.httpTimeout);

}


// Register a cache driver
function registerCacheDriver(name,module) {

	if ( !module.validate || typeof module.validate != "function" )
		throw new Error("Invalid cache driver '"+name+"'! Function 'validate' is invalid or not present.");
	if ( !module.store || typeof module.store != "function" )
		throw new Error("Invalid cache driver '"+name+"'! Function 'store' is invalid or not present.");
	if ( !module.retrieve || typeof module.retrieve != "function" )
		throw new Error("Invalid cache driver '"+name+"'! Function 'retrieve' is invalid or not present.");

	cacheDrivers[name] = module;

}


// Cache a result
function _cacheResult(req,answer) {

	var
		self = this,
		file;

	// For now we only support GET's
	if ( req.method.toUpperCase() !== "GET" )
		return;

	// For each cache backend (more than one?)
	self.backends.forEach(function(be){
		if ( be.type !== "cache" )
			return;

		var
			cacheKey = be.keyGenerator(req)||"NO_HASH";

		// Store
		be.driver.store.apply(self,[cacheKey,answer,be,function(err){
			if ( err )
				self._debug("ERROR:\tError storing entry '"+cacheKey+"' on cache backend "+be.id);
			else
				self._debug("INFO:\tSuccessfully stored entry '"+cacheKey+"' on cache backend "+be.id);
		}]);
	});

}


// Send an error
function _sendError(req,res,error) {

	var
		self = this;

	if ( self.config.errors && typeof self.config.errors == "object" && self.config.errors[error.toString()] ) {
		var errConf = self.config.errors[error.toString()];
		res.writeHead(error,errConf.headers);
		res.end(errConf.document||('HTTP error '+error+'.'));
	}
	else {
		res.writeHead(error,{'content-type':'text/plain; charset=utf-8'});
		res.end('HTTP error '+error+'.');
	}

	return self._log(req,res,null,503.1,17,new Date());

}


/*
 Default FS Cache drive
 */
function _cacheIDFS(be) {

	return be.path;

}
function _cacheValidateFS(be) {

	if ( !be.path )
		throw new Error("Cache backend using 'fs' driver has not 'path'. Please, specify a path.");

	return true;

}

function _cacheStoreFS(key,answer,be,handler) {

	var
		self = this,
		finalFile = be.path+"/"+crypto.createHash('md5').update(key).digest("hex")+".cache",
		tempFile = finalFile+"_tmp";

	// The same entry is already being written? Don't worry about that!
	if ( self.cacheWriting[finalFile] )
		return;
	self.cacheWriting[finalFile] = true;

	// Write to temporary file
	return fs.writeFile(tempFile,answer,function(err){
		if ( err ) {
			console.log("ERROR:\tError writing cache file at '"+tempFile+"': ",err);
			delete self.cacheWriting[finalFile];
			return handler ? handler(err,tempFile) : null;
		}

		// Move the temporary to final file
		return fs.rename(tempFile,finalFile,function(err){
			if ( err ) {
				console.log("ERROR:\tError moving cache file '"+tempFile+"' to '"+finalFile+"': ",err);
				delete self.cacheWriting[finalFile];
				return handler ? handler(err,finalFile) : null;
			}

			self._debug("INFO:\tCache successfully written at '"+finalFile+"'.");
			delete self.cacheWriting[finalFile];
			return handler ? handler(null,finalFile) : null;
		});
	});

}

function _cacheRetrieveFS(key,be,handler) {

	var
		self = this,
		file = be.path+"/"+crypto.createHash('md5').update(key).digest("hex")+".cache";

	self._debug("INFO:\tRetrieving item '"+key+"' from filesystem cache...");

	// Check is the file exists
	return fs.stat(file,function(err,stat){
		if ( err ) {
			if ( err.code == "ENOENT" ) {
				self._debug("INFO:\tItem '"+key+"' on cache.");
				return handler(null,null);
			}
			else {
				self._debug("WARN:\tCannot access cache file '"+file+"': ",err);
				return handler(err,null);
			}
		}

		// The file is not a file?
		if ( !stat.isFile() ) {
			self._debug("WARN:\tThe cache file '"+file+"' exists but is not a file (??)");
			return handler(new Error("Cache file is not a file (??)"),null);
		}

		// Is it expired?
		if ( be.expireTime !== "never" && (stat.mtime + be.expireTime < new Date()) ) {
			self._debug("INFO:\tThe cache file '"+file+"' is expired. Deleting it!");
			handler(null,null);
			return fs.unlink(file,function(){});
		}

		// Get the file contents and return it
		return fs.readFile(file,function(err,data){
			if ( err ) {
				self._debug("ERROR:\tError reading cache file '"+file+"': ",err);
				return handler(err,null);
			}

			self._debug("INFO:\tReturning item '"+key+"' retrieved from cache");

			return handler(null,data);
		});
	});

}

/*
  Useful little stuff, for avoiding dependencies
 */

// Log
function _log(req,res,be,statusCode,length,firstByte,extra) {
	var
		now = new Date(),
		timeSpent = req.xConnectDate ? (now - req.xConnectDate)/1000 : "*",
		timeSpentFirstByte = firstByte ? (now - firstByte)/1000 : "*",
		remoteAddr = req.connection.remoteAddress || (req.client && req.client._peername) ? req.client._peername.address : "UNK";

	console.log(remoteAddr+" - "+(req.xRequestID||"-")+" ["+(be?"BE#"+be.idx:"NO_BE")+"] ["+req.xConnectDate.toString()+"] \""+req.method+" "+req.url+" HTTP/"+req.httpVersionMajor+"."+req.httpVersionMajor+"\" "+statusCode+" "+length+" "+timeSpentFirstByte.toString()+" "+timeSpent.toString()+(extra?" "+extra:""));
}

// Debug
function _debug() {

	if ( !this.DEBUG )
		return;

	var
		args = Array.prototype.slice.call(arguments, 0);

	console.log.apply(null,args);

}

// Merge two objects
function _merge(src,target) {
	for ( var p in src )
		target[p] = src[p];
	return target;
};

// Read a number from a buffer
function _sizeDataToNum(data) {
	return (data[0] << 24) | (data[1] << 16) | (data[2] <<8) | data[3]
}

// Write a number on a buffer
function _sizeNumToData(num,buf,offset) {
	if ( buf == null )
		buf = new Buffer(4);
	if ( offset == null )
		offset = 0;

	buf[offset+0] = (num >> 24) & 0xff;
	buf[offset+1] = (num >> 16) & 0xff;
	buf[offset+2] = (num >> 8) & 0xff;
	buf[offset+3] = num & 0xff;

	return buf;
}
