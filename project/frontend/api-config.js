// Intercepts fetch calls in production so http://localhost:5000/api/... becomes /api/...
(function () {
  var LOCAL_API = 'http://localhost:5000';
  var isLocal =
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1';

  if (!isLocal) {
    var _orig = window.fetch.bind(window);
    window.fetch = function (url, opts) {
      if (typeof url === 'string' && url.startsWith(LOCAL_API)) {
        url = url.slice(LOCAL_API.length) || '/';
      }
      return _orig(url, opts);
    };
  }
})();
