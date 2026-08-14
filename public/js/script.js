document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();

  const email = document.getElementById("email").value;
  const password = document.getElementById("password").value;

  try {
    const csrfResponse = await fetch("/api/auth/csrf", { credentials: "same-origin" });
    const { csrfToken } = await csrfResponse.json();
    const res = await fetch("/api/auth/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ email, password, webSession: true })
    });

    const data = await res.json();

    if (!res.ok) throw new Error(data.error || "Error desconocido");

    localStorage.setItem("user", JSON.stringify(data.user));

    window.location.href = "/dashboard.html";
  } catch (err) {
    document.getElementById("error").textContent = "No se pudo iniciar sesión. Revisa tus datos e inténtalo de nuevo.";
  }
});


