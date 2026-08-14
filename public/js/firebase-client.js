import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js';
import {
  GoogleAuthProvider,
  inMemoryPersistence,
  createUserWithEmailAndPassword,
  getAuth,
  linkWithCredential,
  reload,
  sendEmailVerification,
  sendPasswordResetEmail,
  setPersistence,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js';

let authPromise;

async function json(response) {
  try { return await response.json(); } catch (_error) { return {}; }
}

export async function backend(path, options = {}) {
  const response = await fetch(path, options);
  const data = await json(response);
  if (!response.ok) {
    const error = new Error(data.error || 'No se ha podido completar la operacion.');
    error.code = data.code || '';
    error.status = response.status;
    throw error;
  }
  return data;
}

export async function firebaseAuth() {
  if (!authPromise) {
    authPromise = (async () => {
      const config = await backend('/api/auth/firebase-config');
      const auth = getAuth(initializeApp(config));
      // La web conserva la identidad Firebase solo durante el intercambio por
      // la cookie HttpOnly. No persiste ID tokens en almacenamiento del navegador.
      await setPersistence(auth, inMemoryPersistence);
      auth.languageCode = 'es';
      return auth;
    })();
  }
  return authPromise;
}

export async function csrfToken() {
  return (await backend('/api/auth/csrf')).csrfToken;
}

export async function firebaseStatus(user) {
  const idToken = await user.getIdToken(true);
  return backend('/api/auth/firebase/status', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${idToken}` },
  });
}

export async function createAbleProfile(user, nickname, role) {
  const idToken = await user.getIdToken(true);
  return backend('/api/auth/firebase/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ nickname, role }),
  });
}

export async function createWebSession(user) {
  const idToken = await user.getIdToken(true);
  const csrf = await csrfToken();
  const data = await backend('/api/auth/session-login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
    body: JSON.stringify({ idToken }),
  });
  // La cookie HttpOnly es la unica credencial web persistente.
  await signOut(await firebaseAuth());
  localStorage.removeItem('token');
  localStorage.setItem('user', JSON.stringify(data.user));
  return data;
}

export async function logoutWebSession() {
  try {
    const csrf = await csrfToken();
    await backend('/api/auth/session-logout', {
      method: 'POST',
      headers: { 'x-csrf-token': csrf },
    });
  } finally {
    try { await signOut(await firebaseAuth()); } catch (_error) {}
    sessionStorage.removeItem('legacyToken');
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    localStorage.removeItem('skinSeleccionada');
  }
}

export function friendlyError(error) {
  if (error?.code === 'auth/invalid-email') return 'El correo electronico no es valido.';
  if (['auth/invalid-credential', 'auth/wrong-password', 'auth/user-not-found'].includes(error?.code)) {
    return 'El correo o la contrasena no son correctos.';
  }
  if (error?.code === 'auth/email-already-in-use') return 'No se ha podido completar el alta con esos datos.';
  if (error?.code === 'auth/weak-password') return 'La contrasena debe tener al menos 6 caracteres.';
  if (error?.code === 'auth/too-many-requests') return 'Demasiados intentos. Espera unos minutos.';
  if (error?.code === 'auth/popup-closed-by-user') return 'Has cerrado el acceso con Google.';
  if (error?.code === 'NICKNAME_TAKEN') return 'Ese nickname ya esta en uso.';
  if (error?.code === 'INVALID_NICKNAME') return 'El nickname no tiene un formato valido.';
  if (error?.code === 'AUTH_RATE_LIMITED') return 'Demasiados intentos. Espera unos minutos.';
  return 'No se ha podido completar la autenticacion.';
}

export {
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  linkWithCredential,
  reload,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
};
