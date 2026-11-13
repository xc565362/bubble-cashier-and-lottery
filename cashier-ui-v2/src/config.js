// Single place to point the UI at a different backend mount.
// Dev proxy in vite.config.js forwards this base to the local cashier service.
export const API_BASE = import.meta.env.VITE_API_BASE || '/cashier-api';
