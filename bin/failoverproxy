#!/usr/bin/env node

var
	FailoverProxy = require('../lib/failoverproxy');
	proxy = new FailoverProxy({
		DEBUG: true,
		configFile: process.argv[2] || "conf/default.conf"
	});
