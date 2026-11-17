// Legacy migration: PDF bytes now come from decrypted OneDrive blobs in view.ts.
self.addEventListener('activate', event => event.waitUntil(self.registration.unregister()));
