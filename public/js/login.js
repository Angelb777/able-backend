import {
  GoogleAuthProvider,
  acceptCurrentTerms,
  backend,
  createAbleProfile,
  createWebSession,
  firebaseAuth,
  firebaseStatus,
  friendlyError,
  linkWithCredential,
  reload,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
} from './firebase-client.js';

const form = document.getElementById('loginForm');
const emailNode = document.getElementById('email');
const passwordNode = document.getElementById('password');
const errorNode = document.getElementById('error');
const submitNode = document.getElementById('login-submit');
const googleNode = document.getElementById('google-login');
const verifyNode = document.getElementById('verification-actions');
const onboardingNode = document.getElementById('google-onboarding');
let pendingGoogleUser = null;
let pendingLegacyCredentials = null;

function message(text) { errorNode.textContent = text || ''; }
function loading(value) {
  submitNode.disabled = value;
  googleNode.disabled = value;
  submitNode.textContent = value ? 'Conectando...' : 'Entrar';
}

async function legacyWebLogin(email, password, acceptTerms = false) {
  const csrfResponse = await backend('/api/auth/csrf');
  const data = await backend('/api/auth/login', {
    method: 'POST', headers: {
      'content-type': 'application/json',
      'x-csrf-token': csrfResponse.csrfToken,
    },
    body: JSON.stringify({
      email,
      password,
      webSession: true,
      ...(acceptTerms ? { termsAccepted: true, termsVersion: '1.0' } : {}),
    }),
  });
  localStorage.removeItem('token');
  localStorage.setItem('user', JSON.stringify(data.user));
  location.assign('/dashboard.html');
}

async function finishFirebase(user) {
  const status = await firebaseStatus(user);
  if (status.status === 'needs_profile') {
    pendingGoogleUser = user;
    onboardingNode.hidden = false;
    message('Elige nickname y tipo de cuenta para completar tu alta con Google.');
    return;
  }
  if (status.status === 'terms_required') {
    pendingGoogleUser = user;
    window.AbleLegal.showTermsGate(async () => {
      await acceptCurrentTerms(user);
      await createWebSession(user);
      location.assign('/dashboard.html');
    }, async () => {
      try { await (await import('./firebase-client.js')).logoutWebSession(); }
      finally { location.assign('/login.html'); }
    });
    return;
  }
  await createWebSession(user);
  location.assign('/dashboard.html');
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  message('');
  loading(true);
  const email = emailNode.value.trim();
  const password = passwordNode.value; // Nunca modificar la contrasena con trim.
  try {
    // TEMPORAL (migracion Firebase): los perfiles antiguos con contrasena se
    // validan primero en el backend. Asi el backoffice legacy no depende de que
    // Firebase Web este configurado y nunca se crea/vincula un perfil por email.
    try {
      await legacyWebLogin(email, password);
      return;
    } catch (legacyError) {
      if (legacyError.code === 'TERMS_ACCEPTANCE_REQUIRED') {
        pendingLegacyCredentials = { email, password };
        window.AbleLegal.showTermsGate(async () => {
          const pending = pendingLegacyCredentials;
          if (!pending) throw new Error('Vuelve a iniciar sesión.');
          await legacyWebLogin(pending.email, pending.password, true);
        }, () => location.assign('/login.html'));
        return;
      }
      if (legacyError.code !== 'INVALID_CREDENTIALS') throw legacyError;
    }

    const auth = await firebaseAuth();
    const credential = await signInWithEmailAndPassword(auth, email, password);
    await reload(credential.user);
    if (!credential.user.emailVerified) {
      verifyNode.hidden = false;
      message('Verifica tu correo antes de continuar.');
      return;
    }
    await finishFirebase(credential.user);
  } catch (error) {
    message(friendlyError(error));
  } finally { loading(false); }
});

googleNode.addEventListener('click', async () => {
  message(''); loading(true);
  try {
    const credential = await signInWithPopup(await firebaseAuth(), new GoogleAuthProvider());
    await finishFirebase(credential.user);
  } catch (error) {
    if (error.code === 'auth/account-exists-with-different-credential') {
      const pending = GoogleAuthProvider.credentialFromError(error);
      const email = emailNode.value.trim();
      const password = passwordNode.value;
      if (!pending || !email || !password ||
          (error.customData?.email || '').toLowerCase() !== email.toLowerCase()) {
        message('Ese correo ya usa otro metodo. Escribe su email y contrasena y vuelve a pulsar Google para vincularlo de forma segura.');
      } else {
        try {
          const existing = await signInWithEmailAndPassword(await firebaseAuth(), email, password);
          const linked = await linkWithCredential(existing.user, pending);
          await finishFirebase(linked.user);
        } catch (linkError) { message(friendlyError(linkError)); }
      }
    } else {
      message(friendlyError(error));
    }
  }
  finally { loading(false); }
});

document.getElementById('complete-google-profile').addEventListener('click', async () => {
  const nickname = document.getElementById('google-nickname').value.trim();
  const role = document.getElementById('google-role').value;
  if (!nickname) return message('El nickname es obligatorio.');
  loading(true);
  try {
    await createAbleProfile(pendingGoogleUser, nickname, role);
    await createWebSession(pendingGoogleUser);
    location.assign('/dashboard.html');
  } catch (error) { message(friendlyError(error)); }
  finally { loading(false); }
});

document.getElementById('forgot-password').addEventListener('click', async () => {
  const email = emailNode.value.trim();
  if (!email) return message('Escribe primero tu correo electronico.');
  try {
    await sendPasswordResetEmail(await firebaseAuth(), email);
    message('Si existe una cuenta Firebase, recibiras un correo de recuperacion.');
  } catch (error) { message(error.code === 'auth/invalid-email' ? friendlyError(error) : 'Si existe una cuenta Firebase, recibiras un correo de recuperacion.'); }
});

document.getElementById('resend-verification').addEventListener('click', async () => {
  try { await sendEmailVerification((await firebaseAuth()).currentUser); message('Correo reenviado.'); }
  catch (error) { message(friendlyError(error)); }
});

document.getElementById('verified-email').addEventListener('click', async () => {
  const user = (await firebaseAuth()).currentUser;
  if (!user) return message('Vuelve a iniciar sesion.');
  await reload(user);
  if (!user.emailVerified) return message('El correo todavia no figura como verificado.');
  try { await finishFirebase(user); } catch (error) { message(friendlyError(error)); }
});
