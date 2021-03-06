var url = require('url');
var URLRegex = require('url-regex');
var normalizeURL = require('normalize-url');

/**
 * @param  {String} string - string that may contain URLs
 * @return {Array} list of URLs
 */
function extractURLs(string) {
  var URLs = (string || '').match(URLRegex());

  if (URLs) {
    return URLs.map(function(url) {
      return normalizeURL(url.trim()).replace(/(\.|\,|\(|\))$/, '');
    });
  }

  return [];
}

module.exports = {
  parseURL: url.parse,
  extractURLs: extractURLs
};
