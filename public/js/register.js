import {
  GoogleAuthProvider,
  createAbleProfile,
  createUserWithEmailAndPassword,
  createWebSession,
  firebaseAuth,
  firebaseStatus,
  friendlyError,
  linkWithCredential,
  reload,
  sendEmailVerification,
  signInWithEmailAndPassword,
  signInWithPopup,
} from './firebase-client.js';

const form = document.getElementById('registerForm');
const errorNode = document.getElementById('error');
const submitNode = document.getElementById('register-submit');
const googleNode = document.getElementById('google-register');
const verificationNode = document.getElementById('verification-actions');
let pendingUser = null;

function message(value) { errorNode.textContent = value || ''; }
function values() {
  return {
    nickname: document.getElementById('nickname').value.trim(),
    email: document.getElementById('email').value.trim(),
    password: document.getElementById('password').value,
    role: document.getElementById('rol').value,
  };
}
function validNickname(nickname) {
  return nickname.length >= 3 && nickname.length <= 20 && /^[\p{L}\p{N}_-]+$/u.test(nickname);
}
function loading(value) { submitNode.disabled = value; googleNode.disabled = value; }

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = values();
  if (!validNickname(data.nickname)) return message('El nickname debe tener 3-20 caracteres y usar letras, numeros, guion o guion bajo.');
  loading(true); message('');
  try {
    const credential = await createUserWithEmailAndPassword(await firebaseAuth(), data.email, data.password);
    pendingUser = credential.user;
    await createAbleProfile(pendingUser, data.nickname, data.role);
    await sendEmailVerification(pendingUser);
    verificationNode.hidden = false;
    message('Cuenta creada. Verifica tu correo antes de entrar.');
  } catch (error) {
    // Si Firebase se creo pero el perfil Mongo fallo (red o nickname ocupado),
    // reintentar completa el mismo alta; nunca crea un perfil legacy ni otro UID.
    const auth = await firebaseAuth();
    const current = auth.currentUser;
    if (error.code === 'auth/email-already-in-use' &&
        current?.email?.toLowerCase() === data.email.toLowerCase()) {
      try {
        pendingUser = current;
        await createAbleProfile(current, data.nickname, data.role);
        await sendEmailVerification(current);
        verificationNode.hidden = false;
        message('Cuenta creada. Verifica tu correo antes de entrar.');
      } catch (retryError) { message(friendlyError(retryError)); }
    } else {
      message(friendlyError(error));
    }
  }
  finally { loading(false); }
});

googleNode.addEventListener('click', async () => {
  const data = values();
  if (!validNickname(data.nickname)) return message('El nickname es obligatorio antes de continuar con Google.');
  loading(true); message('');
  try {
    const credential = await signInWithPopup(await firebaseAuth(), new GoogleAuthProvider());
    pendingUser = credential.user;
    const status = await firebaseStatus(pendingUser);
    if (status.status === 'needs_profile') await createAbleProfile(pendingUser, data.nickname, data.role);
    await createWebSession(pendingUser);
    location.assign('/dashboard.html');
  } catch (error) {
    if (error.code === 'auth/account-exists-with-different-credential') {
      const pending = GoogleAuthProvider.credentialFromError(error);
      if (!pending || !data.email || !data.password ||
          (error.customData?.email || '').toLowerCase() !== data.email.toLowerCase()) {
        message('Ese correo ya usa otro metodo. Completa email y contrasena y vuelve a pulsar Google para vincularlo de forma segura.');
      } else {
        try {
          const existing = await signInWithEmailAndPassword(await firebaseAuth(), data.email, data.password);
          const linked = await linkWithCredential(existing.user, pending);
          pendingUser = linked.user;
          const status = await firebaseStatus(pendingUser);
          if (status.status === 'needs_profile') {
            await createAbleProfile(pendingUser, data.nickname, data.role);
          }
          await createWebSession(pendingUser);
          location.assign('/dashboard.html');
        } catch (linkError) { message(friendlyError(linkError)); }
      }
    } else {
      message(friendlyError(error));
    }
  }
  finally { loading(false); }
});

document.getElementById('resend-verification').addEventListener('click', async () => {
  try { await sendEmailVerification(pendingUser); message('Correo reenviado.'); }
  catch (error) { message(friendlyError(error)); }
});

document.getElementById('verified-email').addEventListener('click', async () => {
  if (!pendingUser) return message('Vuelve a iniciar sesion.');
  await reload(pendingUser);
  if (!pendingUser.emailVerified) return message('El correo todavia no figura como verificado.');
  try { await createWebSession(pendingUser); location.assign('/dashboard.html'); }
  catch (error) { message(friendlyError(error)); }
});
