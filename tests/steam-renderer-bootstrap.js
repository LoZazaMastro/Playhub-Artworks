/* Test harness only. Steam factories come from the user's external input files.
 * Use the actual React/ReactDOM renderer and the actual footer-glyph factory.
 * Decky, button enums and localization are isolated test adapters.
 */
(() => {
  const factories = window.__steamFactories;
  const cache = Object.create(null);
  const overrides = {
    14181: {g4: Object.fromEntries(['A','B','X','Y','Left','Right','Up','Down','HomeMenu','QuickMenu','Select','Start','LeftBumper','RightBumper','LeftTrigger','RightTrigger','LeftStick','LeftStickClick','RightStick','RightStickClick','LeftTrackpad','LeftTrackpadClick','RightTrackpad','RightTrackpadClick','RearLeftUpper','RearLeftLower','RearRightUpper','RearRightLower'].map((name,index)=>[name,index]))},
    8658: {A: (...names) => names.filter(Boolean).join(' ')},
    7727: {we: key => key},
  };
  function req(id) {
    if (id in overrides) return overrides[id];
    if (cache[id]) return cache[id].exports;
    if (!factories[id]) throw Error('Missing supplied Steam module ' + id);
    const module = {exports: {}};
    cache[id] = module;
    factories[id](module, module.exports, req);
    return module.exports;
  }
  req.d = (object, definitions) => { for (const key in definitions) Object.defineProperty(object, key, {enumerable: true, get: definitions[key]}); };
  req.n = value => { const getter = value?.__esModule ? () => value.default : () => value; req.d(getter, {a: getter}); return getter; };
  req.o = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  req.r = object => Object.defineProperty(object, '__esModule', {value: true});
  req.g = globalThis;
  const find = marker => {
    const entry = Object.entries(factories).find(([,factory]) => factory.toString().includes(marker));
    if (!entry) throw Error('Missing supplied factory: ' + marker);
    return entry[0];
  };
  window.SP_REACT = req(find('* react.production.js'));
  window.SP_REACTDOM = req(find('* react-dom.production.js'));
  window.__reactDOMClient = req(find('* react-dom-client.production.js'));
  // This factory ID is a test-fixture contract for the supplied Steam 11006468,
  // not a hard-coded dependency of the plugin itself.
  window.__nativeGlyph = req(58470).$m;
  window.__caught = [];
  window.__activated = 0;
  window.__lookupCalls = 0;
  window.__lookupMode = 'native';
  window.__clockOffset = 0;
  const originalNow = Date.now;
  Date.now = () => originalNow() + window.__clockOffset;
  window.DFL = {
    findModuleExport(predicate) {
      window.__lookupCalls++;
      switch (window.__lookupMode) {
        case 'throw': throw Error('Simulated late Decky module scan');
        case 'missing': return undefined;
        case 'invalid': return {notAComponent: true};
        case 'memo': return [SP_REACT.memo(window.__nativeGlyph)].find(predicate);
        case 'forwardRef': return [{$$typeof: Symbol.for('react.forward_ref'), render: window.__nativeGlyph}].find(predicate);
        default: return [undefined, {}, window.__nativeGlyph].find(predicate);
      }
    },
    findSP: () => window,
    IconsModule: {},
    joinClassNames: (...names) => names.filter(Boolean).join(' '),
    Focusable: SP_REACT.forwardRef((props, ref) => SP_REACT.createElement('div', {
      ref, className: props.className, style: props.style, tabIndex: 0,
      onClick: props.onActivate,
    }, props.children)),
  };
  window.__logEvents = [];
  window.__DECKY_SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED_deckyLoaderAPIInit = {
    connect: () => ({call: async (method, ...args) => { window.__logEvents.push([method, ...args]); return true; }}),
  };
  window.__renderCards = (cards) => {
    const Asset = window.__artworksRequire('src/components/asset/Asset.tsx').default;
    const Boundary = window.__artworksRequire('src/components/PluginErrorBoundary.tsx').default;
    if (!window.__testRoot) {
      window.__testRoot = __reactDOMClient.createRoot(document.getElementById('root'), {
        onCaughtError: (error, info) => window.__caught.push({message: error.message, stack: info.componentStack}),
        onUncaughtError: (error, info) => window.__caught.push({message: error.message, stack: info.componentStack, uncaught: true}),
      });
    }
    const content = SP_REACT.createElement(Boundary, {area: 'artwork-page'},
      SP_REACT.createElement('div', {id:'images-container'}, cards.map((card, index) => SP_REACT.createElement(Asset, {
        key: index, assetType: 'grid_p', width: 512, height: 512,
        src: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
        isAnimated: false, provider: 'steamgriddb', author: {name: 'Test author'},
        onActivate: () => { window.__activated++; }, ...card,
      }))));
    SP_REACTDOM.flushSync(() => window.__testRoot.render(content));
  };
})();
