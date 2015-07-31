# failoverproxy
An HTTP proxy which repeats requests to failover backends or returns cached answers in order to successfully answer requests even when the backends are down

## Installing
	npm install -g failoverproxy

## Creating your configuration file

Write something like this:

	{
	
	    local: {
	        address: '0.0.0.0',
	        port: 8086
	    },
		
	    backends: []
	}

Now add some backends to the `backends` array. A backend can be just an URL, the string 'cache' or an object containing `host` and `port`. Some examples:

	{
	    host: '127.0.0.1',
	    port: 8087
	}

	'http://127.0.0.1:8087/'

	'cache'


The backend object supports the following properties:

* `type`   - Backend type (`server` or `cache`). Defaults to `server` when a `host` is specified. Defaults to `cache` when a `path` is specified;

The server backends (`type: "server`) support the following properties:

* `proto`  - Backend protocol (http or https);

* `host`   - The backend hostname;

* `port`   - The backend port; Defaults to `80`;

* `prefix` - The URL prefix to be used on the backend;

The cache backends (`type: "cache"`) support the following properties:

* `driver` - The cache driver to be used. Defaults to `fs`, the only cache driver shipped with failoverproxy;
* `expireTime`  - The number of milliseconds that a cache item takes to expire. Supports numbers or the string `never`;

The `fs` driver supports the following properties:

* `path`   - The directory to store the cached items;

You can watch for more examples on the examples/ directory.


# Other configurations

* `httpTimeout` - The number of milliseconds to wait for a request on the backend (defaults to 5000);

* `httpTestTimeout` - The number of milliseconds to wait on a backend test request (defaults to 1000);

* `backendWatchInterval*  - The number of milliseconds of interval to perform HTTP tests requests to backends with status `down`;

* `backendSelector` - A function which permits to select the next active backend from a supplied list;

* `cache` - An object containing the settings to be used for cache when just the string `'cache'` is used for backend;

* `backends` - An array containing backend objects, URLs (as server backends) or the string `'cache'` as a cache backend using the `cache` configuration settings;

* `errors` - An object containing an index of error codes, containing a `document` string and an `headers` object;


# Run it!

	failoverproxy config_file
