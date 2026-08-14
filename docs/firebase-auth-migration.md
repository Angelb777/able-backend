# Firebase Authentication en Able73

## Modelo de identidad

- Las altas nuevas se autentican en Firebase y crean un único perfil MongoDB con `firebaseUid`.
- MongoDB sigue siendo la autoridad de `role`, nickname, Stepcoins, cartas, inventario, clanes y comercio.
- El registro público solo admite `cliente` (Usuario, valor por defecto) y `comercio`.
- Nunca se enlaza un perfil MongoDB antiguo solo por coincidencia de email.
- El login `/api/auth/login` y su JWT quedan marcados como fallback temporal y solo aceptan documentos existentes con contraseña y sin `firebaseUid`.
- `/api/auth/register` responde `410`; no se pueden crear nuevas cuentas legacy.

## Configuración del backend

Configurar `FIREBASE_PROJECT_ID=able-8a1b8` y una sola forma de credencial Admin:

1. En Google Cloud/Cloud Run, usar Application Default Credentials con una identidad que pueda utilizar Firebase Authentication.
2. En local, guardar el JSON fuera del repositorio y definir `FIREBASE_SERVICE_ACCOUNT_PATH` con su ruta absoluta.
3. En un proveedor con gestor de secretos, inyectar el JSON completo mediante `FIREBASE_SERVICE_ACCOUNT_JSON`.

No copiar ninguna clave privada al repositorio. Para web también hacen falta las variables públicas `FIREBASE_WEB_API_KEY`, `FIREBASE_WEB_AUTH_DOMAIN`, `FIREBASE_WEB_APP_ID` y `FIREBASE_MESSAGING_SENDER_ID` de la aplicación web de Firebase.

En producción se requiere HTTPS para las cookies `Secure`, `NODE_ENV=production` y `ALLOWED_ORIGINS` con los orígenes exactos permitidos. Las cookies de sesión son HttpOnly, SameSite=Lax y todas las mutaciones autenticadas por cookie requieren el token CSRF emitido por `/api/auth/csrf`.

## Firebase Console

- Mantener habilitados Email/Password y Google en Authentication > Sign-in method.
- Añadir los dominios reales y locales necesarios en Authorized domains.
- Registrar SHA-1 y SHA-256 de cada firma Android para Google Sign-In y descargar de nuevo `google-services.json` si cambia la configuración.
- Añadir la aplicación iOS, su `GoogleService-Info.plist`, URL schemes y capacidades correspondientes antes de compilar iOS con Google.
- Revisar remitente, plantilla y dominio de los correos de verificación y recuperación.
- Activar Email Enumeration Protection cuando sea compatible con los flujos del proyecto.
- Apple queda preparado en el modelo (`authProviders`), pero aún requiere habilitar el proveedor, Apple Developer Sign in with Apple, Service ID/Team ID/Key ID y su clave privada en Firebase Console.

## Retirada posterior del fallback

Cuando ya no se necesiten las cuentas de prueba: eliminar las rutas legacy de `api/routes/auth.js`, `userFromLegacyToken`, la cookie `able73_legacy`, la persistencia legacy de Flutter y `JWT_SECRET`. Antes, verificar que no quedan usuarios importantes con contraseña y sin `firebaseUid`.
