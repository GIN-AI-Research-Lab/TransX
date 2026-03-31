// Sharp stub — không cần cho text translation
// @xenova/transformers dùng sharp cho image task, nhưng app này chỉ dùng text.
module.exports = new Proxy({}, {
  get: function(_, prop) {
    if (prop === '__esModule') return false;
    if (prop === 'then') return undefined; // tránh Promise unwrap
    return function() { return module.exports; };
  },
  apply: function() { return module.exports; },
  construct: function() { return module.exports; },
});
