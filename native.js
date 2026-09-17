'use strict';

// Android app integration (Capacitor). In a browser none of this runs.
// Browser downloads don't exist inside the app, so files are written to Documents/PDF Worker
// (falling back to app storage) and can be shared; PDFs opened from other apps load in the editor.

const NATIVE_APP = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
const nativeFiles = new Map(); // file name -> saved file URI, for sharing afterwards

if (NATIVE_APP) {
  document.documentElement.classList.add('native-app');
  // Without a bundler, plugins are reached through the bridge; registerPlugin creates the proxy if needed.
  const cap = window.Capacitor;
  const plugin = (name) => (cap.Plugins && cap.Plugins[name]) || cap.registerPlugin(name);
  const Filesystem = plugin('Filesystem');
  const Share = plugin('Share');
  const App = plugin('App');

  const blobToBase64 = (blob) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });

  async function writeNative(blob, filename) {
    const data = await blobToBase64(blob);
    try {
      const res = await Filesystem.writeFile({ path: `PDF Worker/${filename}`, data, directory: 'DOCUMENTS', recursive: true });
      return { uri: res.uri, where: `Documents/PDF Worker/${filename}` };
    } catch (err) {
      console.warn('Documents not writable, using app storage', err);
      const res = await Filesystem.writeFile({ path: filename, data, directory: 'CACHE' });
      return { uri: res.uri, where: null };
    }
  }

  // Replaces the browser download in export.js.
  saveBlob = async (blob, filename) => {
    try {
      const { uri, where } = await writeNative(blob, filename);
      nativeFiles.set(filename, uri);
      if (where) toast(`Saved to ${where}`);
      else await Share.share({ title: filename, files: [uri], dialogTitle: 'Save or share' });
    } catch (err) {
      console.error(err);
      toast(`Couldn't save ${filename}: ${err.message || err}`);
    }
  };

  window.shareBlob = async (blob, filename) => {
    try {
      let uri = nativeFiles.get(filename);
      if (!uri) {
        uri = (await Filesystem.writeFile({ path: filename, data: await blobToBase64(blob), directory: 'CACHE' })).uri;
      }
      await Share.share({ title: filename, files: [uri], dialogTitle: 'Share' });
    } catch (err) {
      if (!/cancel/i.test(String(err && err.message))) toast(`Couldn't share: ${err.message || err}`);
    }
  };

  // PDFs opened with the app ("Open with PDF Worker").
  async function openFromUri(url) {
    if (!url || !/^(content|file):/i.test(url)) return;
    try {
      const res = await Filesystem.readFile({ path: url });
      const binary = atob(res.data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      let name = decodeURIComponent(url.split('/').pop().split('?')[0] || 'document');
      if (!/\.pdf$/i.test(name)) name = `${name.replace(/^\d+$/, 'document')}.pdf`;
      location.hash = '#/edit';
      await openFiles([new File([bytes], name, { type: 'application/pdf' })], true);
    } catch (err) {
      console.error(err);
      toast(`Couldn't open that file: ${err.message || err}`);
    }
  }
  App.addListener('appUrlOpen', (event) => openFromUri(event.url));
  window.addEventListener('load', () => {
    App.getLaunchUrl().then((res) => res && openFromUri(res.url)).catch(() => {});
  });

  // Android back button: close dialogs, then go back through the app, then leave.
  App.addListener('backButton', () => {
    const modal = openModalId();
    if (modal) { dismissModal(modal); return; }
    if (!$('moreMenu').hidden) { toggleMenu(false); return; }
    if (location.hash.replace(/^#\/?/, '')) {
      if (history.length > 1) history.back();
      else location.hash = '#/';
    } else {
      App.exitApp();
    }
  });
}
