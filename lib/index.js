'use strict';

const Regex = require('../resources/regex');
const Currency = require('../resources/currency');
const Endpoint = require('../resources/endpoint');

const Listing = require('./classes/Listing');
const ListingUser = require('./classes/ListingUser');
const ListingItem = require('./classes/ListingItem');
const ListingSale = require('./classes/ListingSale');
const Histogram = require('./classes/Histogram');

const requestp = require('request-promise');
const cheerio = require('cheerio');

class SteamCrawler {
    constructor(options) {
        options = options || {};

        this._cheerio = cheerio;

        // Default currrency
        this.currency = options.currency || Currency.USD;
        // Add popularity index to class when searching for items?
        this.popularity = {
            use: options.usePopularityIndex || false,
            divider: options.popularityDivider || 10000
        };
        // Use HTTP/HTTPS proxy to mask requests
        this.proxy = options.proxy || null;
        // Set timeout for requests
        this.timeout = options.timeout || 5000;
        // Set MAX_RETRIES for requests
        this.maxRetries = options.maxRetries || 3;
        // Regex's
        this.Regex = Regex;
        // Currencies
        this.Currency = Currency;
        // Endpoints
        this.Endpoint = Endpoint;

        /**
         * Mostly options that are necessary for SteamApis,
         * you can safely ignore these.
         */
        // Use WebProxy to proxy the requests
        this.webProxy = options.webProxy || false;
        // Use Base64 encoded strings as URL's where possible,
        // good when using webProxy - other than that pointless.
        this.base64 = options.base64 || false;
        // Base64 prefix
        this.base64Prefix = options.base64Prefix || 'base64';

        /**
         * Request and its defaults
         */
        this.requestDefaults = options.requestDefaults || {}
        this._request = requestp.defaults(Object.assign({
            proxy: this.proxy,
            headers: {
                'accept-charset': 'utf-8'
            },
            timeout: this.timeout,
            maxRedirects: 5
        }, this.requestDefaults));
    }

    _requestFn (url, json, retries) {
        const params = {};
        if (json) {
            params.transform = body => {
                return JSON.parse(body);
            };
            params.transform2xxOnly = true;
        }
        return this._request({ url, ...params })
            .then(body => {
                if (!json) return body;
                // We received a bad response, lets try to get a good one
                if(typeof body === 'undefined' || !body || body.success === false) {
                    // Check if we can retry
                    const retryable = this.retryable(retries);
                    if(retryable.shouldRetry) {
                        return this.request(url, json, retryable.retries);
                    } else {
                        // The request succeeded but we received a bad/malformed response
                        return Promise.reject('Received bad response from Steam.');
                    }
                } else {
                    return body;
                }
            })
            .catch(error => {
                // Check if we can retry
                const retryable = this.retryable(retries);
                if(retryable.shouldRetry) {
                    return this.request(url, json, retryable.retries);
                } else {
                    return Promise.reject(error);
                }
            });
    }

    request (url, json) {
        return new Promise((resolve, reject) => {
            const req = this._requestFn(url, json, this.maxRetries);
            // Proxies can make request's timeout not function properly
            // have to do this hackish method to trigger our own
            const timer = setTimeout(() => {
                req.cancel();
                return reject('Timed out!');
            }, this.timeout + 3000);
    
            req.then(resolve).catch(reject);
        })
    }

    retryable(retries) {
        // Check if retries is set, otherwise set it at 0
        if(typeof retries === 'undefined') {
            retries = 0;
        } else {
            retries++;
        }
        // Not hit the max retries yet
        if(retries <= this.maxRetries) {
            return { retries: retries, shouldRetry: true };
        } else {
            // We hit the max retry amount
            return { retries: retries, shouldRetry: false };
        }
    }

    getSearch(parameters) {
        const url = this.buildUrl(Endpoint.search(parameters));

        return this.request(url, false).then((body) => {
            let results = this.seperateListingsFromHTML(body);
            let listings = [];

            for(let i in results) {
                listings.push(new Listing(results[i], parameters, this.popularity));
            }

            // return the Listings array
            return listings;
        }).catch((error) => {
            // return error
            return Promise.reject(error);
        });
    }

    getSearchRender(parameters) {
        let returnResponseOnly = false;
        if(parameters.responseOnly) {
            returnResponseOnly = true;
            delete parameters.responseOnly;
        }

        const url = this.buildUrl(Endpoint.searchRender(parameters));

        return this.request(url, true).then((body) => {
            if( ! returnResponseOnly) {
                let results = this.seperateListingsFromHTML(body.results_html);
                let listings = [];

                for(let i in results) {
                    listings.push(new Listing(results[i], parameters, this.popularity));
                }

                // return the Listings array
                body = listings;
            }

            // returns either listings arr or body
            return body;
        }).catch((error) => {
            return Promise.reject(error);
        });
    }

    getListings(appID, market_hash_name, loadHistogram) {
        const url = this.buildUrl(Endpoint.listings(appID, market_hash_name));

        return this.request(url, false).then((body) => {
            body = this._cheerio.load(body);
            let Listing = new ListingItem(body);

            if(loadHistogram) {
                return this.getHistogram(Listing)
                    .then(data => {
                        return [body, data]
                    })
                    .catch(err => {
                        return [body, Listing]
                    })
            } else {
                return [body, Listing];
            }
        }).then((results) => {
            // return the Listing item
            return results[1];
        }).catch((error) => {
            // return error
            return Promise.reject(error);
        });
    }

    getListingSales(ListingItem, parameters) {
        if( ! ListingItem) {
            return Promise.reject('You have to provide the `nameID` value of the ListingItem');
        }

        const url = this.buildUrl(Endpoint.listingSales(ListingItem.appID, ListingItem.market_hash_name, parameters));

        return this.request(url, true).then((data) => {
            let results = this.seperateListingsFromHTML(data.results_html);
            let sales = [];

            for(let i in results) {
                sales.push(new ListingSale(results[i], data.listinginfo));
            }

            return sales;
        }).catch((error) => {
            return Promise.reject(error);
        });
    }

    getHistogram(ListingItem) {
        if( ! ListingItem) {
            return Promise.reject('You have to provide the `nameID` value of the ListingItem');
        }
        let nameID;
        if(typeof ListingItem === 'object') {
            nameID = ListingItem.nameID;
        } else {
            nameID = ListingItem;
        }
        if(typeof nameID === 'undefined' || ! nameID) {
            return Promise.reject('Invalid `nameID` value.');
        }

        const url = this.buildUrl(Endpoint.itemordershistogram(nameID));

        return this.request(url, true).then((data) => {
            // If we got an object, return data with the object
            if(typeof ListingItem === 'object') {
                ListingItem.histogram = new Histogram(data);
                return ListingItem;
            }
            return new Histogram(data);
        }).catch((error) => {
            return Promise.reject(error);
        });
    }

    getRecentActivity(ListingItem) {
        if( ! ListingItem) {
            return Promise.reject('You have to provide the `nameID` value of the ListingItem');
        }
        let nameID;
        if(typeof ListingItem === 'object') {
            nameID = ListingItem.nameID;
        } else {
            nameID = ListingItem;
        }
        if(typeof nameID === 'undefined' || ! nameID) {
            return Promise.reject('Invalid `nameID` value.');
        }

        const url = this.buildUrl(Endpoint.itemordersactivity(nameID));

        return this.request(url, true).then((data) => {
            // If we got an object, return data with the object
            if(typeof ListingItem === 'object') {
                ListingItem.recent_activity = data;
                return ListingItem;
            }
            return data;
        }).catch((error) => {
            return Promise.reject(error);
        });
    }

    getPopular(start, count) {
        const url = this.buildUrl(Endpoint.popular(start, count));

        return this.request(url, true).then((data) => {
            let listings = [];

            for(let i in data.results_html) {
                let $ = this._cheerio.load(data.results_html[i].toString('utf8'));
                listings.push(new Listing($, {}, this.popularity));
            }

            // return the Listings array
            return listings;
        }).catch((error) => {
            // return error
            return Promise.reject(error);
        });
    }

    getRecent() {
        const url = this.buildUrl(Endpoint.recent());

        return this.request(url, true).then((data) => {
            let json = {
                listings: [],
                last_time: data.last_time,
                last_listing: data.last_listing
            };

            for(let i in data.listinginfo) {
                json.listings.push(new ListingUser(data.listinginfo[i], data.assets));
            }

            // return the listings object
            return json;
        }).catch((error) => {
            // return error
            return Promise.reject(error);
        });
    }

    getRecentCompleted() {
        const url = this.buildUrl(Endpoint.recentcompleted());

        return this.request(url, true).then((data) => {
            let json = {
                listings: [],
                last_time: data.last_time,
                last_listing: data.last_listing
            };

            for(let i in data.purchaseinfo) {
                json.listings.push(new ListingUser(data.purchaseinfo[i], data.assets));
            }

            // return the listings object
            return json;
        }).catch((error) => {
            // return error
            return Promise.reject(error);
        });
    }

    setProxy(proxy) {
        this.proxy = proxy;
        this._request = requestp.defaults(Object.assign({
            proxy: this.proxy,
            headers: {
                'accept-charset': 'utf-8'
            },
            timeout: this.timeout,
            maxRedirects: 5
        }, this.requestDefaults));
    }
    
    setDefaults(options) {
        this._request = requestp.defaults(Object.assign({
            headers: {
                'accept-charset': 'utf-8'
            },
            timeout: this.timeout,
            maxRedirects: 5
        }, options))
    }

    buildUrl(endpoint) {
        // Check if we need to use base64 or default url
        const URL = (this.base64 && endpoint.base64) ? this.base64Prefix + endpoint.base64 : endpoint.url;
        // Check if webProxy was specified
        if(this.webProxy) {
            return `${this.webProxy}&contains=${endpoint.contains}&url=${URL}`;
        }
        // No webProxy - return default url
        return endpoint.url;
    }

    seperateListingsFromHTML(html) {
        const $ = cheerio.load(html.toString('utf8'));
        let results = [];

        let selector = '.market_listing_row';
        if($('.market_listing_row_link').length) {
            selector = '.market_listing_row_link';
        }

        $(selector).each((index, element) => {
            results.push(cheerio.load(element));
        });

        return results;
    }
}

module.exports = SteamCrawler;
