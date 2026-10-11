// Turns <time data-relative> into "3 hours ago", in the reader's own clock.
// Without JavaScript the build-time text ("on 10 October at 21:40 UTC") stays.
(function () {
  if (typeof Intl === 'undefined' || !Intl.RelativeTimeFormat) return;
  var rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  var steps = [
    ['year', 31536000], ['month', 2592000], ['week', 604800],
    ['day', 86400], ['hour', 3600], ['minute', 60]
  ];
  function update() {
    var els = document.querySelectorAll('time[data-relative]');
    for (var i = 0; i < els.length; i++) {
      var t = Date.parse(els[i].getAttribute('datetime'));
      if (isNaN(t)) continue;
      var seconds = (t - Date.now()) / 1000;
      var text = 'just now';
      for (var j = 0; j < steps.length; j++) {
        if (Math.abs(seconds) >= steps[j][1]) {
          text = rtf.format(Math.round(seconds / steps[j][1]), steps[j][0]);
          break;
        }
      }
      els[i].textContent = text;
    }
  }
  update();
  setInterval(update, 60000);
})();
