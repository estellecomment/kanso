/*global Buffer: true */

/**
 * Module dependencies
 */

var url = require('url'),
    http = require('http'),
    //logger = require('./logger'),
    querystring = require('querystring');


var CouchDB;

/**
 * Convenience method for creating a CouchDB object instance.
 *
 * @param {String} db_url
 * @api public
 */

var exports = module.exports = function (db_url) {
    return new CouchDB(db_url);
};

/**
 * The CouchDB object constructor.
 *
 * @class CouchDB
 * @constructor
 * @param {String} db_url
 * @api public
 */

CouchDB = exports.CouchDB = function (db_url) {
    var ins = this.instance = url.parse(db_url);
    if (!ins.port) {
        if (ins.protocol === 'https:') {
            ins.port = 443;
        }
        else {
            ins.port = 80;
        }
    }
};

/**
 * Tests if a database exists, creates it if not.
 *
 * @param {Function} callback
 * @api public
 */

CouchDB.prototype.ensureDB = function (callback) {
    var that = this;
    this.exists('', function (err, exists) {
        if (err || exists) {
            return callback(err, that);
        }
        that.createDB(callback);
    });
};

/**
 * Creates a database.
 *
 * @param {Function} callback
 * @api public
 */

CouchDB.prototype.createDB = function (callback) {
    this.client('PUT', '', null, callback);
};

/**
 * Convenience HTTP client for querying a CouchDB instance. Buffers and parses
 * JSON responses before passing to callback. JSON.stringify's data before
 * sending.
 *
 * @param {String} method
 * @param {String} path
 * @param data
 * @param {Function} callback
 * @api public
 */

CouchDB.prototype.client = function (method, path, data, callback) {
    path = (this.instance.pathname || '') + '/' + path;

    var headers = {
        'Host': this.instance.hostname,
        'Accept': 'application/json'
    };
    if (method === 'POST' || method === 'PUT') {
        if (typeof data !== 'string') {
            try {
                data = JSON.stringify(data);
            }
            catch (e) {
                return callback(e);
            }
        }
        headers['Content-Type'] = 'application/json';
    }
    else if (data) {
        path = url.parse(path).pathname + '?' + querystring.stringify(data);
    }

    if (this.instance.auth) {
        var enc = new Buffer(this.instance.auth).toString('base64');
        headers.Authorization = "Basic " + enc;
    }

    var client = http.createClient(this.instance.port, this.instance.hostname);
    client.on('error', callback);
    var request = client.request(method, path, headers);

    request.on('response', function (response) {
        /*logger.debug('response:', {
            headers: response.headers,
            url: response.url,
            method: response.method,
            statusCode: response.statusCode
        });*/
        var buffer = [];
        response.on('data', function (chunk) {
            buffer.push(chunk.toString());
        });
        response.on('end', function () {
            var data = buffer.length ? JSON.parse(buffer.join('')): null;
            //logger.debug('data:', data);
            if (response.statusCode >= 300) {
                if (data && data.error) {
                    //var err = new Error(data.reason || data.error);
                    var err = new Error(data.reason || data.error);
                    err.error = data.error;
                    err.reason = data.reason;
                    err.response = response;
                    callback(err, data, response);
                }
                else {
                    var err2 = new Error('Status code: ' + response.statusCode);
                    callback(err2, data, response);
                }
            }
            else {
                callback(null, data, response);
            }
        });
    });

    if (data && (method === 'POST' || method === 'PUT')) {
        request.write(data, 'utf8');
    }
    request.end();

    //logger.debug('request:', request.output[0]);
};

/**
 * Test if a doc exists in the db by doing a HEAD request - doesn't fetch
 * the whole document.
 *
 * @param {String} id
 * @param {Function} callback
 * @api public
 */

CouchDB.prototype.exists = function (id, callback) {
    id = id || '';
    this.client('HEAD', id, null, function (err, data, res) {
        res = res || {};
        if (res.statusCode !== 404 && err) {
            return callback(err);
        }
        var exists = (res.statusCode === 200);
        var etag = res.headers.etag;
        var _rev = etag ? etag.substr(1, etag.length - 2): null;
        callback(null, exists, _rev);
    });
};

/**
 * Retrieve a document from a CouchDB instance.
 *
 * @param {String} id
 * @param {Object} data
 * @param {Function} callback
 * @api public
 */

CouchDB.prototype.get = function (id, /*optional*/data, callback) {
    if (arguments.length < 3) {
        callback = data;
        data = null;
    }
    this.client('GET', (id || ''), data, callback);
};

/**
 * Saves a document to a CouchDB instance.
 *
 * Options:
 *      {Boolean} force - write document regardless of conflicts!
 *
 * @param {String} id
 * @param {Object} doc
 * @param {Object} options
 * @param {Function} callback
 * @api public
 */

CouchDB.prototype.save = function (id, doc, /*optional*/options, callback) {
    var that = this;

    if (!callback) {
        callback = options;
        options = {};
    }
    var method = id ? 'PUT': 'POST';
    var path = id || '';

    if (options.force) {
        // WARNING! this is a brute-force document update
        // updates revision number to latest revision before saving
        this.exists(id, function (err, exists, rev) {
            if (err) {
                return callback(err);
            }
            if (exists) {
                doc._rev = rev;
            }
            that.client(method, path, doc, function (err, d) {
                if (err) {
                    return callback(err);
                }
                doc._id = d.id;
                doc._rev = d.rev;
                callback(null, doc);
            });
        });
    }
    else {
        this.client(method, path, doc, callback);
    }
};

/**
 * Deletes a document from a CouchDB instance.
 *
 * Options:
 *      {Boolean} force - delete document regardless of conflicts!
 *
 * @param {String} id
 * @param {Object} rev
 * @param {Object} options
 * @param {Function} callback
 * @api public
 */

CouchDB.prototype.delete = function (id, rev, /*optional*/options, callback) {
    var that = this;

    if (!callback) {
        callback = options;
        options = {};
    }
    var args = {};
    if (rev) {
        args.rev = rev;
    }
    var path = id || '';

    if (options.force) {
        // WARNING! this is a brute-force document delete
        // updates revision number to latest revision before deleting
        this.exists(id, function (err, exists, rev) {
            if (err) {
                return callback(err);
            }
            if (exists) {
                args.rev = rev;
            }
            that.client('DELETE', path, args, callback);
        });
    }
    else {
        this.client('DELETE', path, args, callback);
    }
};