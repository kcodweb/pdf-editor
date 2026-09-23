'use strict';

// Password protection. pdf-lib can't encrypt or decrypt, so a worker runs a fork of it
// (@cantoo/pdf-lib) that can. Kept in a worker so it doesn't clash with the main pdf-lib.

let secureWorker = null;
let secureCallId = 0;
const secureCalls = new Map();

function secureCall(type, bytes, options = {}) {
  if (!secureWorker) {
    const lib = new URL('vendor/pdf-lib-secure.min.js', document.baseURI).href; // tool pages use <base href="../">
    const source = `importScripts(${JSON.stringify(lib)});
      self.onmessage = async (e) => {
        const { id, type, bytes, options } = e.data;
        try {
          const L = self.PDFLib;
          let doc;
          if (type === 'decrypt') {
            doc = await L.PDFDocument.load(bytes, { password: options.password || '' });
          } else {
            doc = await L.PDFDocument.load(bytes);
            doc.encrypt(options);
          }
          const out = await doc.save();
          self.postMessage({ id, bytes: out }, [out.buffer]);
        } catch (err) {
          self.postMessage({ id, error: String((err && err.message) || err) });
        }
      };`;
    secureWorker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
    secureWorker.onmessage = (e) => {
      const call = secureCalls.get(e.data.id);
      if (!call) return;
      secureCalls.delete(e.data.id);
      if (e.data.error) call.reject(new Error(e.data.error));
      else call.resolve(e.data.bytes);
    };
    secureWorker.onerror = (e) => {
      for (const call of secureCalls.values()) call.reject(new Error(e.message || 'Encryption worker failed'));
      secureCalls.clear();
      secureWorker = null;
    };
  }
  return new Promise((resolve, reject) => {
    const id = ++secureCallId;
    secureCalls.set(id, { resolve, reject });
    const copy = bytes.slice();
    secureWorker.postMessage({ id, type, bytes: copy, options }, [copy.buffer]);
  });
}

const decryptPdf = (bytes, password) => secureCall('decrypt', bytes, { password });
const encryptPdf = (bytes, options) => secureCall('encrypt', bytes, options);

// Cheap check for an /Encrypt entry near either end of the file (where trailers live).
function looksEncrypted(bytes) {
  const needle = [47, 69, 110, 99, 114, 121, 112, 116]; // "/Encrypt"
  const scan = (from, to) => {
    outer: for (let i = Math.max(0, from); i <= Math.min(bytes.length, to) - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer;
      return true;
    }
    return false;
  };
  const window = 256 * 1024;
  return scan(bytes.length - window, bytes.length) || (bytes.length > window && scan(0, window));
}

// Asks for a password; resolves to the text, or null if cancelled.
function askPassword(fileName, wrong) {
  return new Promise((resolve) => {
    $('pwFile').textContent = fileName;
    $('pwError').hidden = !wrong;
    $('pwInput').value = '';
    openModal('pwModal');
    setTimeout(() => $('pwInput').focus());
    const finish = (value) => {
      $('pwForm').removeEventListener('submit', onSubmit);
      $('pwCancel').removeEventListener('click', onCancel);
      pwDismiss = null;
      closeModal('pwModal');
      resolve(value);
    };
    const onSubmit = (e) => { e.preventDefault(); finish($('pwInput').value); };
    const onCancel = () => finish(null);
    $('pwForm').addEventListener('submit', onSubmit);
    $('pwCancel').addEventListener('click', onCancel);
    pwDismiss = onCancel;
  });
}
let pwDismiss = null;

// Opens protected PDFs: asks for the password when one is needed and returns decrypted bytes,
// or null if the user gave up. Unprotected files come back unchanged.
async function unlockBytes(bytes, fileName) {
  if (!looksEncrypted(bytes)) return { bytes, encrypted: false };
  let password = null;
  try {
    await (await pdfjsLib.getDocument({ data: bytes.slice() }).promise).destroy();
  } catch (err) {
    if (!err || err.name !== 'PasswordException') throw err;
    let wrong = false;
    for (;;) {
      password = await askPassword(fileName, wrong);
      if (password === null) return null;
      try {
        await (await pdfjsLib.getDocument({ data: bytes.slice(), password }).promise).destroy();
        break;
      } catch (e) {
        if (!e || e.name !== 'PasswordException') throw e;
        wrong = true;
      }
    }
  }
  // Permissions-only protection opens without a password but still has to be decrypted to edit.
  return { bytes: await decryptPdf(bytes, password || ''), encrypted: true };
}
