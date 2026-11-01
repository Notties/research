(function () {
  'use strict';
  // The map viewer. For now it only boots: it reads the map that the page carries in #map-data, sets the page title from
  // its topic and writes the topic into the top bar. The interactive map grows from here.
  // This file is inlined into index.html after D3, DRShared and DRCore, so none of them may be missing when it runs.
  const TITLE_PREFIX = 'แผนที่ความรู้: '; // the same prefix that scripts/lib/render.cjs puts in <title>

  function boot() {
    const data = document.getElementById('map-data');
    if (!data) throw new Error('the page has no #map-data element');
    const topic = JSON.parse(data.textContent).topic ?? '';
    document.title = TITLE_PREFIX + topic;
    document.getElementById('dr-title').textContent = topic;
  }

  window.DRApp = { boot };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
