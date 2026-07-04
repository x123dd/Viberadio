// audio-bridge.js — SSE connection to Viberadio local server
var HOST = 'http://localhost:38080';
var audioState = {
  playing: false, title: '', artist: '', cover: '',
  frequencyData: [], primaryColor: '#d6f8ff', secondaryColor: '#9cffdf',
};
var bridgeReady = false;

function connectBridge() {
  var es = new EventSource(HOST + '/api/wallpaper/stream');

  es.onopen = function() {
    bridgeReady = true;
  };

  es.onmessage = function(event) {
    try {
      var data = JSON.parse(event.data);
      audioState = data;
    } catch (e) {}
  };

  es.onerror = function() {
    bridgeReady = false;
    // EventSource auto-reconnects with exponential backoff
  };

  return es;
}
