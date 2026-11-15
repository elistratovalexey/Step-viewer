window.AndroidBridge = {
  post: function (json) {
    window.dispatchEvent(new CustomEvent('sv-event', { detail: json }));
  }
};
