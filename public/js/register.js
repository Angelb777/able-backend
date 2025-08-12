document.getElementById("registerForm").addEventListener("submit", async (e) => {
  e.preventDefault();

  const nombre = document.getElementById("nombre").value.trim();
  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;
  const role = document.getElementById("rol").value; // ✅ CAMBIADO a 'role'

  // ⛔ Validación manual obligatoria al usar preventDefault()
  if (!nombre || !email || !password || !role) {
    document.getElementById("error").innerText = "Todos los campos son obligatorios";
    return;
  }

  try {
    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nombre, email, password, role }) // ✅ role aquí también
    });

    const data = await res.json();

    if (!res.ok) throw new Error(data.error || "Error al registrar");

    alert("✅ Cuenta creada correctamente. Ahora puedes iniciar sesión.");
    window.location.href = "/login.html";
  } catch (err) {
    console.error(err);
    document.getElementById("error").innerText = err.message;
  }
});
