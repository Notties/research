(function () {
  'use strict';
  // The map viewer. For now it only boots: it reads the map that the page carries in #map-data, names the page after its
  // topic and writes that name into the top bar. The interactive map grows from here.
  // This file is inlined into index.html after D3, DRShared and DRCore, so none of them may be missing when it runs.
  const TITLE_PREFIX = 'แผนที่ความรู้: '; // the same title that scripts/lib/render.cjs puts in <title>

  function boot() {
    const data = document.getElementById('map-data');
    if (!data) throw new Error('the page has no #map-data element');
    const map = JSON.parse(data.textContent);
    const title = TITLE_PREFIX + (map.topic ?? '');
    document.title = title;
    document.getElementById('dr-title').textContent = title;
  }

  window.DRApp = { boot };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
