let user; // Declarado globalmente
let userId;
let role;
let cartaSeleccionada = null;
let cartaSeleccionadaDiv = null;
let usuario = null;
let map = null;
let intervaloOvnisActivo = null;
let ovnisActivos = [];
let puedeCambiarCarta = true;
let cooldownTimeout = null;
let cartaArrastrada = null;
let marcadorUsuario = null;  // tu skin en el mapa
let overlayArrow = null;     // la flecha de apuntado
let disparoEnProgreso = false;
let recenterTimeout;
let miPosicion = null;
let mapaUsuario;
let intentosGeo = 0;
let arrowMarker = null;
let inicioDrag = null;
let listenerMouseDown = null;
let listenerMouseMove = null;
let listenerMouseUp = null;
let ovniYaMostrado = false;
let ovnisActivosMarkers = [];
let ufoModelo = null;
let ovniTimer = null;
let ovniTimeout = null;
let marcadorOvni = null;
let intervaloDisparosOvni = null;
let userData = null;
let skinSeleccionada = null;
let estaMuerto = false;
let reviveTimeoutId = null;
let skinParadoActualUrl = null; 
let skinMuriendoActualUrl = null;
let lastSkinApplied = null;
let cartasGestion = [];
let cartaEditandoId = null;
let ufosGestion = [];
let ufoEditandoId = null;



document.addEventListener("DOMContentLoaded", async () => {
  const userRaw = localStorage.getItem("user");
  if (!userRaw) return window.location.href = "/login.html";

  try {
    user = JSON.parse(userRaw);
  } catch (e) {
    console.error("❌ Error al parsear el usuario:", e);
    localStorage.removeItem("user");
    return window.location.href = "/login.html";
  }

  if (!user.id) {
    console.error("❌ user.id está vacío o undefined");
    localStorage.removeItem("user");
    return window.location.href = "/login.html";
  }

  userId = user.id;
  role = user.role;

  try {
    const res = await fetch(`/api/users/${userId}`);
    if (!res.ok) throw new Error("Error en la petición");

    const updatedUser = await res.json();
    localStorage.setItem("user", JSON.stringify(updatedUser));
    user = updatedUser;
    console.log("✅ Usuario actualizado");
  } catch (err) {
    console.error("❌ Error al refrescar usuario:", err);
    alert("Error al obtener datos actualizados del usuario");
  }

  const menuItems = {
    cliente: [
      "Inicio",
      "CSR (Cartas, Skins y Ruleta)",
      "Able 73 – Visión Dios",
      "Rankings",
      "Descuentos y premios",
      "Retos",
      "Mis pagos",
      "Mis trayectos",
      "Mis vehículos"
    ],
    comercio: [
      "Promociones",
      "Promoción local físico",
      "Crea la Skin de tu comercio",
      "Lista de compradores",
      "Añadir descuentos o premios",
      "Pagos Comercio"
    ],
    admin: [
      "Validar",
      "Lista de usuarios",
      "Pagos",
      "Gestion de juego",
      "Trayectos",
      "Incidencias",
      "Datos",
      "Añadir descuentos o premios",
      "Crear Retos",
      "Lista de compradores",
      "Candados",
      "Pedidos"
    ]
  };

  const menu = document.getElementById("menu");
  const content = document.getElementById("content");
  const items = menuItems[role] || [];

  items.forEach((item, index) => {
    const li = document.createElement("li");
    li.textContent = item;
    li.addEventListener("click", () => renderSection(item));
    menu.appendChild(li);

    // Mostrar primera sección automáticamente
    if (index === 0) renderSection(item);
  });
});

// Función auxiliar
function esperarElementoYMostrar(id, callback) {
  const el = document.getElementById(id);
  if (el) {
    callback(el);
  } else {
    setTimeout(() => esperarElementoYMostrar(id, callback), 50);
  }
}

// Renderizado de secciones
function renderSection(section) {
  console.log(`📌 renderSection: ${section}, rol: ${role}`);
  document.querySelectorAll(".seccion").forEach((s) => (s.style.display = "none"));

  switch (section) {
    case "Inicio":
      renderInicio();
      break;
    case "Pagos":
      if (role === "admin") renderPagos();
      break;
    case "Lista de usuarios":
      renderUsuarios();
      break;
    case "Promoción local físico":
      if (role === "comercio") renderPromoLocal();
      break;  
    case "Datos":
      if (role === "admin") renderDatos();
      break;
    case "Añadir descuentos o premios":
      renderRewardsSection();
      break;
    case "Crear Retos":
      if (role === "admin") renderCrearRetos();
      break;
    case "Retos":
      if (role === "cliente") renderRetosCliente();
      break;
    case "Pedidos":
      if (role === "admin") renderPedidosAdmin();
      break;    
    case "Validar":
      if (role === "admin") renderValidarRewards();
      break;
    case "Descuentos y premios":
      if (role === "cliente") renderVistaClienteRewards();
      break;
    case "Rankings":
    const seccionRanking = document.getElementById("rankings");
    if (seccionRanking) seccionRanking.style.display = "block";
    renderRankings();
    break;  
    case "Crea la Skin de tu comercio":
    const seccionSkin = document.getElementById("creaSkinComercio");
    if (seccionSkin) seccionSkin.style.display = "block";
    break;
    case "Promociones":
    if (role === "comercio") renderMisPromociones();
    break;  
    case "Pagos Comercio":
    if (role === "comercio") renderPagosComercio();
    break;
    case "Mis pagos":
      if (role === "cliente") renderMisPagos();
      break;
    case "Lista de compradores":
      if (role === "comercio" || role === "admin") {
        esperarElementoYMostrar("compradores", async (compradoresSection) => {
          document.querySelectorAll(".seccion").forEach((s) => (s.style.display = "none"));
          compradoresSection.style.display = "block";
          console.log("✅ Mostrando sección Lista de compradores");
          await renderListaCompradores(); // ✅ SIN PASAR user.id
        });
      }
      break;
    case "Gestion de juego":
      if (role === "admin") renderGestionJuego();
      break;
    case "CSR (Cartas, Skins y Ruleta)":
      if (role === "cliente") {
        const sectionEl = document.getElementById("csr");
        if (sectionEl) {
          sectionEl.style.display = "block";
          renderSkinsCliente();
          cargarCartas(); 
          cargarCartasCliente();
          inicializarRuleta(); 
          renderMisSkinsCliente();
          const options = [
            "Tira de nuevo",
            "20000 Stepcoins",
            "Nada",
            "500 Stepcoins",
            "Carta aleatoria",
            "Juego de cultura"
          ];
          crearEtiquetas(options);
        }
      }
      break;
    case "Able 73 – Visión Dios":
  const seccionVision = document.getElementById("visionDios");
  if (seccionVision) {
    seccionVision.style.display = "block";
    renderMisSkinsCliente();
    detenerCompartirUbicacion();

    iniciarGeolocalizacion(() => {
      renderVisionDios();

      // ✅ Evita múltiples intervalos si ya existe
      clearInterval(intervaloOvnisActivo); // 🔁 Reinicia si ya existía
    });
  }
  break;

  case "Candados":
  if (role === "admin") {
    const seccion = document.getElementById("candados");
    if (seccion) seccion.style.display = "block"; // ← ACTIVA LA SECCIÓN
    renderCandados();
  }
  break;
    default:
      console.warn(`⚠️ La sección "${section}" aún no está implementada.`);
  }
}

// Función que renderiza las métricas
async function renderDatos() {
  document.querySelectorAll(".seccion").forEach(s => s.style.display = "none");

  const seccion = document.getElementById("datos");
  if (!seccion) {
    console.warn("❌ No se encontró la sección #datos en el DOM.");
    return;
  }

  seccion.style.display = "block";
  seccion.innerHTML = `
    <h2>Datos y Métricas</h2>
    <div style="margin-bottom:10px">
      <button onclick="generarMetricas()">⚙️ Generar métricas ahora</button>
      <button onclick="renderTablaMetricas('monthly')">📅 Ver métricas mensuales</button>
      <button onclick="renderTablaMetricas('yearly')">📈 Ver métricas anuales</button>
      <button onclick="descargarExcel('monthly')">⬇️ Excel mensual</button>
      <button onclick="descargarExcel('yearly')">⬇️ Excel anual</button>
    </div>
    <div id="metricasTabla"></div>
  `;

  renderTablaMetricas("monthly");
}

async function renderTablaMetricas(tipo) {
  const res = await fetch(`/api/metrics?type=${tipo}`);
  const metricas = await res.json();
  const contenedor = document.getElementById("metricasTabla");

  if (!metricas.length) {
    contenedor.innerHTML = `<p>No hay métricas registradas aún.</p>`;
    return;
  }

  contenedor.innerHTML = `
    <h3>${tipo === 'monthly' ? 'Métricas Mensuales' : 'Métricas Anuales'}</h3>
    <table>
      <thead>
        <tr>
          <th>Periodo</th>
          <th>Usuarios totales</th>
          <th>Usuarios nuevos</th>
          <th>Usuarios que han pagado</th>
          <th>% que han pagado</th>
          <th>Facturación total (€)</th>
          <th>Ticket medio (€)</th>
        </tr>
      </thead>
      <tbody>
        ${metricas.map(m => `
          <tr>
            <td>${m.period}</td>
            <td>${m.values.totalUsers}</td>
            <td>${m.values.newUsers}</td>
            <td>${m.values.payingUsers}</td>
            <td>${m.values.payingUsersPercent}%</td>
            <td>${m.values.totalRevenue.toFixed(2)}</td>
            <td>${m.values.avgTicket.toFixed(2)}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

async function generarMetricas() {
  try {
    const res = await fetch("/api/metrics/generate", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Error del servidor");
    alert(data.message || "✅ Métricas generadas correctamente");
    renderTablaMetricas("monthly"); // recarga vista mensual
  } catch (err) {
    alert("❌ Error al generar métricas");
    console.error(err);
  }
}


function descargarExcel(tipo) {
  window.open(`/api/metrics/excel?type=${tipo}`);
}

function renderInicio() {
  console.log("Ejecutando renderInicio()");

  // ✅ Siempre cargar el usuario actualizado desde localStorage
  const userRaw = localStorage.getItem("user");
  let user;

  try {
    user = JSON.parse(userRaw);
  } catch (e) {
    console.warn("⚠️ Error al parsear user en renderInicio()");
    user = {};
  }

  if (!user?._id) {
    console.warn("⚠️ No hay usuario válido en localStorage.");
    return;
  }

  const section = document.getElementById("inicio");
  if (!section) {
    console.warn("⚠️ No se encontró la sección #inicio en el DOM.");
    return;
  }

  // Mostrar solo esta sección y ocultar las demás
  document.querySelectorAll(".seccion").forEach(s => s.style.display = "none");
  section.style.display = "block";

  section.innerHTML = `
    <h2>Inicio</h2>
    <h3>Información del usuario</h3>
    <label>Nombre: <input id="editNombre" value="${user.nombre}" /></label><br><br>
    <label>Correo: <input class="readonly" value="${user.email}" readonly /></label><br><br>
    <button onclick="guardarNombre()">Guardar cambios</button>
    <br><br>
    <div class="stepcoins">🪙 Stepcoins: ${user.stepcoins}</div>

    <h3 style="margin-top: 40px;">Tienda de Stepcoins</h3>
    <div class="stepcoin-grid">
      ${generarPaquetesStepcoins()}
    </div>
  `;

  // 🔁 Escuchar clics en los botones de compra
  document.querySelectorAll(".boton-compra").forEach(boton => {
    boton.addEventListener("click", async () => {
      const cantidad = parseInt(boton.dataset.cantidad);

      try {
        const res = await fetch("/api/payments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: user._id,
            cantidad: cantidad
          })
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Error al procesar el pago");

        alert("✅ ¡Compra realizada con éxito!");

        // ✅ Actualizar en localStorage
        user.stepcoins += cantidad;
        localStorage.setItem("user", JSON.stringify(user));

        // 🔁 Volver a renderizar la sección con el nuevo saldo
        renderInicio();
      } catch (err) {
        console.error("❌ Error al comprar stepcoins:", err);
        alert("❌ Hubo un problema al procesar tu compra.");
      }
    });
  });
}

async function guardarNombre() {
  const nuevoNombre = document.getElementById("editNombre").value;
  if (!nuevoNombre || nuevoNombre === user.nombre) return;

  try {
    const res = await fetch(`/api/users/${user._id}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ nombre: nuevoNombre })
    });

    if (!res.ok) {
  const errorData = await res.json();
  throw new Error(errorData.error || "Error al guardar en el servidor");
}

    const actualizado = await res.json();
    user.nombre = actualizado.nombre;
    localStorage.setItem("user", JSON.stringify(user));

    alert("✅ Nombre actualizado correctamente.");
    renderInicio();
  } catch (err) {
    console.error("❌ Error al guardar nombre:", err);
    alert("❌ No se pudo actualizar el nombre.");
  }
}

function generarPaquetesStepcoins() {
  const paquetes = [
    { cantidad: 100, precio: 1 },
    { cantidad: 500, precio: 4 },
    { cantidad: 1000, precio: 7 },
    { cantidad: 2000, precio: 12 },
    { cantidad: 5000, precio: 25 },
  ];

  return paquetes.map(p =>
    `<div class="stepcoin-card">
      <h3>${p.cantidad} Stepcoins</h3>
      <p>💵 ${p.precio} €</p>
      <button class="boton-compra" data-cantidad="${p.cantidad}" data-precio="${p.precio}">
        Comprar
      </button>
    </div>`
  ).join("");
}

async function renderMisPagos() {
  const section = document.getElementById("misPagos");
  section.style.display = "block";

  console.log("🧪 Intentando cargar pagos para:", userId); // Agregado

  try {
    const res = await fetch(`/api/payments/${userId}`);
    if (!res.ok) throw new Error("No se pudieron cargar los pagos");

    const pagos = await res.json();
    const tbody = section.querySelector("tbody");
    tbody.innerHTML = "";

    if (pagos.length === 0) {
      tbody.innerHTML = "<tr><td colspan='2'>No tienes pagos registrados.</td></tr>";
      return;
    }

    pagos.forEach(pago => {
      const tr = document.createElement("tr");
      const fecha = new Date(pago.fecha).toLocaleDateString("es-ES");
      tr.innerHTML = `
        <td>${fecha}</td>
        <td>${pago.cantidad} Stepcoins</td>
      `;
      tbody.appendChild(tr);
    });

  } catch (err) {
    console.error("❌ Error al mostrar pagos:", err);
    alert("No se pudieron cargar los pagos.");
  }
}

async function renderPagosComercio() {
  document.querySelectorAll(".seccion").forEach(s => s.style.display = "none");

  const seccion = document.getElementById("pagosComercio");
  if (!seccion) {
    console.warn("❌ No se encontró la sección #pagosComercio");
    return;
  }

  seccion.style.display = "block";
  seccion.innerHTML = `<h2>Tus Pagos Realizados</h2><table><thead>
    <tr><th>Cantidad (€)</th><th>Motivo</th><th>Fecha</th></tr></thead><tbody id="pagosComercioBody"></tbody></table>`;

  try {
    const res = await fetch(`/api/payments/${user._id}`);
    const pagos = await res.json();

    const tbody = document.getElementById("pagosComercioBody");

    if (!Array.isArray(pagos) || pagos.length === 0) {
      tbody.innerHTML = `<tr><td colspan="3">No has realizado ningún pago aún.</td></tr>`;
      return;
    }

    tbody.innerHTML = pagos.map(p => `
      <tr>
        <td>${p.cantidad}</td>
        <td>${p.motivo || "-"}</td>
        <td>${new Date(p.fecha).toLocaleString()}</td>
      </tr>
    `).join("");
  } catch (err) {
    console.error("❌ Error al cargar pagos del comercio:", err);
    seccion.innerHTML += `<p style="color:red;">Error al cargar los pagos.</p>`;
  }
}

async function renderPagos() {
  document.querySelectorAll(".seccion").forEach(s => s.style.display = "none");

  const seccion = document.getElementById("pagos");
  if (!seccion) {
    console.warn("❌ No se encontró la sección #pagos en el DOM.");
    return;
  }

  seccion.style.display = "block";

  seccion.innerHTML = `
    <h2>Lista de Pagos</h2>
    <input type="text" id="searchInput" placeholder="Buscar por nombre o cantidad" />
    <table>
      <thead><tr><th>Usuario</th><th>Cantidad (€)</th><th>Fecha</th></tr></thead>
      <tbody id="pagosBody"></tbody>
    </table>
  `;

  try {
    const res = await fetch("/api/payments");
    const pagos = await res.json();
    const tbody = document.getElementById("pagosBody");
    const input = document.getElementById("searchInput");

    function renderLista(filtrados) {
      tbody.innerHTML = filtrados.map(p =>
        `<tr>
          <td>${p.nombre}</td>
          <td>${p.cantidad}</td>
          <td>${new Date(p.fecha).toLocaleString()}</td>
        </tr>`).join("");
    }

    renderLista(pagos);

    input.addEventListener("input", () => {
      const q = input.value.toLowerCase();
      const filtrados = pagos.filter(p =>
        p.nombre.toLowerCase().includes(q) ||
        String(p.cantidad).includes(q)
      );
      renderLista(filtrados);
    });
  } catch (err) {
    console.error("❌ Error al cargar pagos:", err);
    seccion.innerHTML += `<p style="color:red;">Error al cargar la lista de pagos.</p>`;
  }
}

async function renderUsuarios() {
  document.querySelectorAll(".seccion").forEach(s => s.style.display = "none");

  const seccion = document.getElementById("usuarios");
  if (!seccion) {
    console.warn("❌ No se encontró la sección #usuarios en el DOM.");
    return;
  }

  seccion.style.display = "block";

  seccion.innerHTML = `
    <h2>Lista de Usuarios</h2>
    <div id="userStats" style="margin-bottom: 15px;"></div>
    <input type="text" id="searchUser" placeholder="Buscar por nombre o email" />
    <div id="userList" style="margin-top:20px;"></div>
  `;

  // Cargar estadísticas
  try {
    const statsRes = await fetch("/api/users/stats");
    const stats = await statsRes.json();

    document.getElementById("userStats").innerHTML = `
      👥 Total: <strong>${stats.total}</strong> |
      🧑‍💼 Clientes: <strong>${stats.clientes}</strong> |
      🛍️ Comercios: <strong>${stats.comercios}</strong>
    `;
  } catch (err) {
    console.error("❌ Error al cargar estadísticas de usuarios:", err);
  }

  // Cargar usuarios
  try {
    const usersRes = await fetch("/api/users");
    const users = await usersRes.json();

    mostrarListaUsuarios(users);

    const input = document.getElementById("searchUser");
    input.addEventListener("input", (e) => {
      const texto = e.target.value.toLowerCase();
      const filtrados = users.filter(u =>
        u.nombre.toLowerCase().includes(texto) ||
        u.email.toLowerCase().includes(texto)
      );
      mostrarListaUsuarios(filtrados);
    });
  } catch (err) {
    console.error("❌ Error al cargar usuarios:", err);
  }
}


function mostrarListaUsuarios(lista) {
  const contenedor = document.getElementById("userList");
  contenedor.innerHTML = "";

  lista.forEach(user => {
    const div = document.createElement("div");
    div.style.border = "1px solid #ccc";
    div.style.padding = "10px";
    div.style.marginBottom = "10px";
    div.innerHTML = `
      <strong>${user.nombre}</strong> (${user.role})<br>
      Email: ${user.email}<br>
      Stepcoins: ${user.stepcoins}<br>
      <button onclick="verDetalles('${user._id}')">Ver detalles</button>
      <button onclick="eliminarUsuario('${user._id}')">🗑️ Eliminar</button>
    `;
    contenedor.appendChild(div);
  });
}

function verDetalles(userId) {
  fetch(`/api/users/${userId}`)
    .then(res => res.json())
    .then(user => {
      const p = user.profile || {};
      alert(`
Nombre: ${user.nombre}
Email: ${user.email}
Rol: ${user.role}
Stepcoins: ${user.stepcoins}
Cartas: ${user.cartas?.join(", ") || "Ninguna"}
Fecha de registro: ${new Date(user.createdAt).toLocaleString()}

— Perfil (rellenado en app) —
Nombre (app): ${p.name || '-'}
Apellidos: ${p.lastName || '-'}
Dirección: ${p.address || '-'}
Ciudad: ${p.city || '-'}
País: ${p.country || '-'}

DNI frontal: ${p.idCardFront || '-'}
DNI trasera: ${p.idCardBack || '-'}
Carnet frontal: ${p.licenseFront || '-'}
Carnet trasera: ${p.licenseBack || '-'}
      `);
    });
}

function eliminarUsuario(userId) {
  if (confirm("¿Estás seguro de que quieres eliminar este usuario?")) {
    fetch(`/api/users/${userId}`, { method: "DELETE" })
      .then(res => res.json())
      .then(() => {
        alert("✅ Usuario eliminado");
        renderUsuarios(); // recarga
      });
  }
}

async function renderRewardsSection() {
  document.querySelectorAll(".seccion").forEach(s => s.style.display = "none");

  const seccion = document.getElementById("rewards");
  if (!seccion) {
    console.warn("❌ No se encontró la sección #rewards en el DOM.");
    return;
  }

  seccion.style.display = "block";

  seccion.innerHTML = `
    <h2>Añadir Descuentos o Premios</h2>

    <form id="formReward" enctype="multipart/form-data">
      <label for="tipo">Tipo:</label>
      <select id="tipo" name="tipo" required>
        <option value="descuento">Descuento</option>
        <option value="premio">Premio</option>
      </select>

      <label for="titulo">Título:</label>
      <input type="text" id="titulo" name="titulo" required>

      <label for="descripcion">Descripción:</label>
      <textarea id="descripcion" name="descripcion" required></textarea>

      <label for="direccion">Dirección del local:</label>
      <input type="text" id="direccion" name="direccion" required>

      <div id="descuentoCampos">
        <label for="tipoDescuento">Tipo de descuento:</label>
        <select id="tipoDescuento" name="tipoDescuento">
          <option value="%">%</option>
          <option value="€">€</option>
        </select>

        <label for="valorDescuento">Cantidad:</label>
        <input type="number" id="valorDescuento" name="valorDescuento" step="0.01">
      </div>

      <label for="stepcoins">Precio en Stepcoins:</label>
      <input type="number" id="stepcoins" name="stepcoins" required>

      <label for="imagenes">Imágenes (hasta 3):</label>
      <input type="file" id="imagenes" name="imagenes" accept="image/*" multiple required>

      <button type="submit">Crear</button>
    </form>

    <h3>${role === "admin" ? "Todos los anuncios publicados y pendientes" : "Mis Anuncios"}</h3>
    <div id="misRewards" class="lista-rewards"></div>
  `;

  document.getElementById("tipo").addEventListener("change", actualizarCampos);
  document.getElementById("formReward").addEventListener("submit", crearReward);

  actualizarCampos();
  cargarMisRewards();
}

function actualizarCampos() {
  const tipo = document.getElementById("tipo").value;
  const campos = document.getElementById("descuentoCampos");
  campos.style.display = tipo === "descuento" ? "block" : "none";
}

async function crearReward(e) {
  e.preventDefault();

  const form = document.getElementById("formReward");
  const formData = new FormData(form);

  const tipo = formData.get("tipo");
  if (tipo === "descuento") {
    const tipoDescuento = formData.get("tipoDescuento");
    const valor = formData.get("valorDescuento");

    if (tipoDescuento === "%") {
      formData.append("porcentaje", valor);
    } else {
      formData.append("cantidadEuros", valor);
    }
  }

  try {
    const token = localStorage.getItem("token") || "";
    const res = await fetch("/api/rewards", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Error al crear");

    alert("✅ Descuento/Premio creado");
    form.reset();
    actualizarCampos();
    cargarMisRewards();
  } catch (err) {
    alert(`❌ ${err.message || "Error al crear reward"}`);
    console.error(err);
  }
}

async function cargarMisRewards() {
  const contenedor = document.getElementById("misRewards");
  contenedor.innerHTML = "<p>Cargando...</p>";

  try {
    const token = localStorage.getItem("token") || "";
    const url = role === "admin"
      ? "/api/rewards/gestion"
      : `/api/rewards/mis/${userId}`;
    const res = await fetch(url, {
      headers: role === "admin"
        ? { Authorization: `Bearer ${token}` }
        : {}
    });
    const rewards = await res.json();
    if (!res.ok) throw new Error(rewards.error || "No se pudo cargar el catálogo");
    if (!Array.isArray(rewards)) throw new Error("Respuesta inválida");

    if (rewards.length === 0) {
      contenedor.innerHTML = "<p>No has creado ningún anuncio todavía.</p>";
      return;
    }

    contenedor.innerHTML = rewards.map(r => `
      <div class="reward-card">
        <h4>${r.titulo}</h4>
        <p><strong>${r.tipo === 'descuento' ? 'Descuento' : 'Premio'}</strong></p>
        <p>${r.descripcion}</p>
        <p>🎯 Stepcoins: ${r.stepcoins}</p>
        ${r.porcentaje ? `<p>💸 Descuento: ${r.porcentaje}%</p>` : ""}
        ${r.cantidadEuros ? `<p>💶 Descuento: ${r.cantidadEuros}€</p>` : ""}
        <p>📍 ${r.direccion}</p>
        <p>🟢 Estado: ${r.validado || r.creadoPorAdmin ? "Publicado" : "Pendiente de validación"}</p>
        ${r.imagenes.map(img => `<img src="${img}" width="100" style="margin:5px;">`).join("")}
        <br>
        <button onclick="eliminarReward('${r._id}')">🗑️ Eliminar</button>
      </div>
    `).join("");
  } catch (err) {
    console.error("Error cargando rewards:", err);
    contenedor.innerHTML = "<p>❌ Error al cargar tus anuncios</p>";
  }
}

async function renderValidarRewards() {
  document.querySelectorAll(".seccion").forEach(s => s.style.display = "none");

  const seccion = document.getElementById("validar");
  if (!seccion) {
    console.warn("❌ No se encontró la sección #validar en el DOM.");
    return;
  }

  seccion.style.display = "block";

  seccion.innerHTML = `<h2>Validar promociones de comercios</h2><div id="listaPendientes">Cargando...</div>`;

  try {
    const res = await fetch("/api/rewards/pendientes");
    const rewards = await res.json();

    const contenedor = document.getElementById("listaPendientes");

    if (rewards.length === 0) {
      contenedor.innerHTML = "<p>🎉 No hay promociones pendientes</p>";
      return;
    }

    contenedor.innerHTML = rewards.map(r => `
      <div class="reward-card">
        <h4>${r.titulo}</h4>
        <p><strong>${r.tipo === 'descuento' ? 'Descuento' : 'Premio'}</strong></p>
        <p>${r.descripcion}</p>
        <p>🎯 Stepcoins: ${r.stepcoins}</p>
        ${r.porcentaje ? `<p>💸 Descuento: ${r.porcentaje}%</p>` : ""}
        ${r.cantidadEuros ? `<p>💶 Descuento: ${r.cantidadEuros}€</p>` : ""}
        <p>📍 ${r.direccion}</p>
        ${r.imagenes.map(img => `<img src="${img}" width="100" style="margin:5px;">`).join("")}
        <br>
        <button onclick="validarReward('${r._id}')">✅ Validar</button>
        <button onclick="eliminarReward('${r._id}')">🗑️ Eliminar</button>
      </div>
    `).join("");
  } catch (err) {
    console.error("Error cargando pendientes:", err);
    document.getElementById("listaPendientes").innerHTML = "❌ Error al cargar.";
  }
}

async function eliminarReward(id) {
  if (!confirm("¿Seguro que quieres eliminar este anuncio?")) return;
  try {
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`/api/rewards/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "No se pudo eliminar");

    alert("✅ Eliminado correctamente");

    // El admin borra desde la lista de validación; el comercio (o el admin
    // desde "Añadir") borra desde "Mis anuncios". Recarga la lista visible.
    const validar = document.getElementById("validar");
    const validacionVisible =
      validar && window.getComputedStyle(validar).display !== "none";

    if (role === "admin" && validacionVisible) {
      await renderValidarRewards();
    } else {
      await cargarMisRewards();
    }
  } catch (err) {
    alert(`❌ ${err.message || "Error al eliminar"}`);
    console.error(err);
  }
}

async function validarReward(id) {
  if (!confirm("¿Seguro que quieres validar este reward?")) return;
  try {
    const res = await fetch(`/api/rewards/${id}/validar`, {
      method: "PATCH",
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    alert("✅ Reward validado");
    renderValidarRewards();
  } catch (err) {
    alert("❌ Error al validar reward");
    console.error(err);
  }
}

async function renderVistaClienteRewards() {
  console.log("Ejecutando renderVistaClienteRewards()");

  const seccion = document.getElementById("vistaClienteRewards");
  if (!seccion) {
    console.warn("❌ No se encontró la sección #vistaClienteRewards en el DOM.");
    return;
  }

  // Ocultar todas las secciones
  document.querySelectorAll(".seccion").forEach(s => s.style.display = "none");
  seccion.style.display = "block";

  const contenedor = document.getElementById("rewardsDisponiblesCliente");
  contenedor.innerHTML = "<p>Cargando...</p>";

  try {
    const res = await fetch("/api/rewards/validados"); // ✅ usa orden por prioridad
    const rewards = await res.json();

    if (!Array.isArray(rewards) || rewards.length === 0) {
      contenedor.innerHTML = "<p>No hay descuentos ni premios disponibles todavía.</p>";
      return;
    }

    contenedor.innerHTML = rewards.map(r => `
      <div class="reward-card" style="border:1px solid #ccc; padding:12px; margin-bottom:15px; border-radius:10px; background:#f9f9f9">
        <h4 style="margin-top:0;">${r.titulo}</h4>
        <p><strong>${r.tipo === 'descuento' ? 'Descuento' : 'Premio'}</strong></p>
        <p>${r.descripcion}</p>
        <p>🎯 Stepcoins: <strong>${r.stepcoins}</strong></p>
        ${r.porcentaje ? `<p>💸 ${r.porcentaje}% de descuento</p>` : ""}
        ${r.cantidadEuros ? `<p>💶 ${r.cantidadEuros}€ de descuento</p>` : ""}
        <p>📍 ${r.direccion}</p>
        <div style="margin-top:8px; margin-bottom:8px;">
          ${r.imagenes.map(img => `
            <img src="${img}" width="100" style="margin:5px; border-radius:6px;" onerror="this.style.display='none';">
          `).join("")}
        </div>
        <button onclick="canjearReward('${r._id}', ${r.stepcoins})" style="padding:6px 12px; background:#ece537; border:none; border-radius:6px; cursor:pointer;">
          Canjear por ${r.stepcoins} 🪙
        </button>
      </div>
    `).join("");
  } catch (err) {
    console.error("❌ Error cargando rewards validados:", err);
    contenedor.innerHTML = "<p>❌ Error al cargar los descuentos</p>";
  }
}

async function promocionarReward(id, nivel) {
  const precio = nivel === 1 ? 20 : nivel === 2 ? 15 : 5;

  if (!confirm(`¿Confirmas el pago de ${precio}€ para promocionar este reward?`)) return;

  // Asegúrate de tener el usuario cargado desde localStorage
  const user = JSON.parse(localStorage.getItem("user"));
  if (!user || !user._id) {
    alert("⚠️ No se encontró el usuario. Intenta volver a iniciar sesión.");
    return;
  }

  try {
    // 1. Destacar el reward
    const res = await fetch(`/api/rewards/${id}/destacar`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nivel })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    alert(data.message || "✅ Promocionado correctamente");

    // 2. Registrar el pago
    await fetch("/api/payments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: user._id,
        cantidad: precio
      })
    });

    // 3. Recargar la vista
    renderMisPromociones();

  } catch (err) {
    console.error("❌ Error al promocionar reward:", err);
    alert("❌ Error al promocionar reward");
  }
}

async function canjearReward(id, coste) {
  const userId = user._id;

  if (user.stepcoins < coste) {
    alert("❌ No tienes suficientes Stepcoins");
    return;
  }

  if (!confirm(`¿Seguro que quieres canjear este reward por ${coste} Stepcoins?`)) return;

  try {
    const res = await fetch(`/api/rewards/${id}/comprar`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ userId })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    alert("✅ Canje exitoso");

    // Actualizar variable global `user`
    user = await fetch(`/api/users/${userId}`).then(res => res.json());
    localStorage.setItem("user", JSON.stringify(user));
    renderVistaClienteRewards();
  } catch (err) {
    alert("❌ Error al canjear: " + err.message);
    console.error("Detalles del error:", err);
  }
}

document.addEventListener("click", async (e) => {
  if (e.target.classList.contains("boton-compra")) {
    const cantidad = parseInt(e.target.dataset.cantidad);
    const precio = parseFloat(e.target.dataset.precio);

    try {
      const res = await fetch("/api/stepcoins/adjust", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: user._id,
          cantidad,
          tipo: "compra",
          descripcion: `Compra de ${cantidad} stepcoins por ${precio} €`
        })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      alert("✅ Compra realizada");
      user = data.user;
      localStorage.setItem("user", JSON.stringify(user));
      renderInicio(); // Actualiza el contador en pantalla

    } catch (err) {
      alert("❌ Error al procesar compra: " + err.message);
    }
  }
});

async function renderMisPromociones() {
  const seccion = document.getElementById("promociones");
  if (!seccion) return;

  // Ocultar otras secciones
  document.querySelectorAll(".seccion").forEach(s => s.style.display = "none");
  seccion.style.display = "block";

  const contenedor = document.getElementById("contenedorPromociones");
  contenedor.innerHTML = "<p>Cargando promociones...</p>";

  try {
    const res = await fetch(`/api/rewards/mis/${user._id}`);
    const rewards = await res.json();

    if (!rewards.length) {
      contenedor.innerHTML = "<p>No has creado promociones todavía.</p>";
      return;
    }

    contenedor.innerHTML = rewards.map(r => `
      <div class="reward-card">
        <h3>${r.titulo}</h3>
        <p>${r.descripcion}</p>
        <p>📍 ${r.direccion}</p>
        <p>💰 Stepcoins: ${r.stepcoins}</p>
        <p>Estado: ${r.validado ? '✅ Validado' : '⏳ Pendiente'}</p>
        ${r.destacado ? `<p>🔥 Destacado nivel ${r.nivelDestacado}</p>` : ""}
        <div>
          <button onclick="promocionarReward('${r._id}', 1)">💎 Top 5 (20€)</button>
          <button onclick="promocionarReward('${r._id}', 2)">⭐ 6-10 (15€)</button>
          <button onclick="promocionarReward('${r._id}', 3)">📢 11-20 (5€)</button>
        </div>
      </div>
    `).join("");
  } catch (err) {
    console.error("Error al cargar promociones del comercio:", err);
    contenedor.innerHTML = "<p>❌ Error al cargar promociones.</p>";
  }
}

async function destacarReward(rewardId) {
  const select = document.getElementById(`nivelDestacado-${rewardId}`);
  const nivel = parseInt(select.value);

  if (!nivel || nivel < 1 || nivel > 3) {
    alert("❌ Nivel no válido.");
    return;
  }

  const confirmar = confirm(`¿Deseas destacar este reward como TOP ${nivel * 5}? Se descontarán Stepcoins si aplica.`);
  if (!confirmar) return;

  try {
    const res = await fetch(`/api/rewards/destacar/${rewardId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nivel }),
    });

    const data = await res.json();
    if (res.ok) {
      alert("✅ Reward destacado con éxito.");
    } else {
      alert("❌ Error al destacar: " + data.error);
    }
  } catch (err) {
    console.error("Error destacando reward:", err);
    alert("❌ Error al destacar reward.");
  }
}

async function renderListaCompradores() {
  const lista = document.getElementById("listaCompradores");
  const buscador = document.getElementById("buscadorCompradores");

  if (!user || !user._id || !user.role) {
    console.warn("⚠️ Usuario no encontrado o incompleto");
    return;
  }

  let url;
  if (user.role === "admin") {
    url = `/api/rewards/compras`; // <-- una ruta que devuelva todos los compradores
  } else {
    url = `/api/rewards/compras/${user._id}`; // para comercios, sigue usando su id
  }

  try {
    const res = await fetch(url);
    const compradores = await res.json();

    console.log("📦 Compradores recibidos:", compradores);

    let filtrados = Array.isArray(compradores) ? compradores : [];

    buscador.addEventListener("input", () => {
      const q = buscador.value.toLowerCase();
      filtrados = compradores.filter(c =>
        c.compradorNombre.toLowerCase().includes(q) ||
        c.compradorEmail.toLowerCase().includes(q)
      );
      pintar();
    });

    function pintar() {
      lista.innerHTML = "";

      if (!Array.isArray(filtrados)) {
        console.warn("⚠️ filtrados no es un array, se cancela renderizado.");
        return;
      }

      filtrados.forEach(c => {
        const div = document.createElement("div");
        div.className = "comprador-card";
        div.innerHTML = `
          <b>${c.compradorNombre}</b> (${c.compradorEmail})<br>
          Compró: <i>${c.rewardTitulo}</i><br>
          <button onclick="validarCompra('${c.rewardId}', '${c.compradorId}')">✅ Validar</button>
        `;
        lista.appendChild(div);
      });
    }

    pintar();
  } catch (err) {
    console.error("❌ Error al cargar compradores", err);
  }
}

async function validarCompra(rewardId, compradorId) {
  if (!confirm("¿Confirmar que ha usado el descuento?")) return;
  try {
    await fetch("/api/rewards/validar-compra", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rewardId, compradorId })
    });
    alert("✅ Compra validada");
    renderListaCompradores();
  } catch (err) {
    alert("❌ Error al validar compra");
    console.error(err);
  }
}

document.addEventListener("click", async (e) => {
  // Validar reward
  if (e.target.classList.contains("btn-validar")) {
    const rewardId = e.target.closest(".reward").dataset.id;
    try {
      await fetch(`/api/rewards/validar/${rewardId}`, { method: "POST" });
      alert("✅ Recompensa validada");
      renderRewardsSection(); // Recargar la lista
    } catch (err) {
      console.error("❌ Error al validar reward:", err);
      alert("❌ No se pudo validar");
    }
  }

  // Eliminar reward
  if (e.target.classList.contains("btn-eliminar")) {
    const rewardId = e.target.closest(".reward").dataset.id;
    if (!confirm("¿Eliminar esta recompensa?")) return;

    try {
      const token = localStorage.getItem("token") || "";
      if (!token) {
        throw new Error("Tu sesión ha caducado. Vuelve a iniciar sesión.");
      }

      const res = await fetch(`/api/rewards/${rewardId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || `Error ${res.status} al eliminar`);
      }

      alert("🗑️ Recompensa eliminada");
      await renderRewardsSection(); // Confirmar el estado real del servidor
    } catch (err) {
      console.error("❌ Error al eliminar reward:", err);
      alert(`❌ ${err.message || "No se pudo eliminar"}`);
    }
  }
});

async function renderUfoManager() {
  const lista = document.getElementById("listaUfos");
  if (!lista) {
    console.warn("❌ No se encontró #listaUfos en el DOM.");
    return;
  }

  try {
    const res = await fetch("/api/ufo");
    const ufos = await res.json();
    if (!res.ok) throw new Error(ufos.error || "Error al cargar OVNIs");
    ufosGestion = ufos;

    lista.innerHTML = "";

    if (ufos.length === 0) {
      lista.innerHTML = "<li>No hay OVNIs creados.</li>";
      return;
    }

    for (const ufo of ufos) {
      const li = document.createElement("li");
      li.style.marginBottom = "20px";
      li.style.padding = "10px";
      li.style.border = "1px solid #ccc";
      li.style.borderRadius = "8px";
      li.style.backgroundColor = "#111";
      li.style.color = "#eee";
      li.style.display = "flex";
      li.style.alignItems = "center";
      li.style.gap = "15px";

      li.innerHTML = `
        <img src="${ufo.imagenOvni}" alt="ovni" style="width: 60px; height: 60px; object-fit: cover; border-radius: 6px;">
        <div>
          <strong>${ufo.nombre}</strong><br>
          🧪 Vida: ${ufo.vida}<br>
          ⏳ Aparece tras: ${ufo.tiempoAparicion}s<br>
          🕒 Dura en pantalla: ${ufo.duracionPantalla}s<br>
          💰 Premio: ${ufo.stepcoinsPremio} stepcoins
        </div>
        <div style="margin-left:auto;display:flex;gap:8px;flex-wrap:wrap;">
          <button style="background:#1565c0;color:white;padding:5px 10px;border:none;border-radius:4px;cursor:pointer;" onclick="editarUfo('${ufo._id}')">✏️ Editar</button>
          <button style="background:#c62828;color:white;padding:5px 10px;border:none;border-radius:4px;cursor:pointer;" onclick="eliminarUfo('${ufo._id}')">Eliminar</button>
        </div>
      `;

      lista.appendChild(li);
    }

  } catch (err) {
    console.error("❌ Error al renderizar OVNIs:", err);
    lista.innerHTML = "<li>Error al cargar OVNIs</li>";
  }
}

function cancelarEdicionUfo() {
  const form = document.getElementById("crearUfoForm");
  if (!form) return;

  ufoEditandoId = null;
  form.reset();
  form.querySelector('[name="imagenOvni"]').required = true;
  form.querySelector('[name="imagenBala"]').required = true;

  const submit = document.getElementById("submitUfo");
  const cancelar = document.getElementById("cancelarEdicionUfo");
  const estado = document.getElementById("estadoEdicionUfo");
  if (submit) submit.textContent = "Crear OVNI";
  if (cancelar) cancelar.style.display = "none";
  if (estado) {
    estado.textContent = "";
    estado.style.display = "none";
  }
}

function editarUfo(id) {
  const ufo = ufosGestion.find((item) => item._id === id);
  const form = document.getElementById("crearUfoForm");
  if (!ufo || !form) return;

  cancelarEdicionUfo();
  ufoEditandoId = id;

  [
    "nombre",
    "vida",
    "velocidadBala",
    "velocidadMovimiento",
    "tiempoAparicion",
    "duracionPantalla",
    "stepcoinsPremio",
    "segundosEntreDisparos",
    "danoBala"
  ].forEach((campo) => {
    const input = form.elements.namedItem(campo);
    if (input) input.value = ufo[campo] ?? "";
  });

  form.querySelector('[name="imagenOvni"]').required = false;
  form.querySelector('[name="imagenBala"]').required = false;

  const submit = document.getElementById("submitUfo");
  const cancelar = document.getElementById("cancelarEdicionUfo");
  const estado = document.getElementById("estadoEdicionUfo");
  if (submit) submit.textContent = "Guardar cambios";
  if (cancelar) cancelar.style.display = "inline-block";
  if (estado) {
    estado.textContent =
      `Editando “${ufo.nombre}”. Las imágenes actuales se conservarán si no eliges archivos nuevos.`;
    estado.style.display = "block";
  }

  form.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function eliminarUfo(id) {
  if (!confirm("¿Seguro que deseas eliminar este OVNI?")) return;

  try {
    const res = await fetch(`/api/ufo/${id}`, {
      method: "DELETE"
    });

    const data = await res.json();
    alert("🗑️ OVNI eliminado correctamente");
    renderUfoManager();
  } catch (err) {
    console.error("❌ Error al eliminar OVNI:", err);
    alert("❌ No se pudo eliminar el OVNI");
  }
}

const SKIN_ACTIONS = [
  ["idle", "Parado / Idle", false, true],
  ["walk", "Moviéndose / Walk", false, true],
  ["shoot", "Disparando / Shoot", false, false],
  ["die", "Muriendo / Die", false, false],
  ["run", "Rápido / Run", true, true],
  ["damage", "Recibiendo daño / Damage", true, false],
  ["getUp", "Reapareciendo / GetUp", true, false]
];
let skinsAdminCache = [];

function inicializarFormularioSkins() {
  const container = document.getElementById("skinAnimationFields");
  if (!container || container.dataset.ready) return;
  container.innerHTML = SKIN_ACTIONS.map(([key, label, optional, loopsByDefault]) => `
    <div class="skin-animation-field" data-action="${key}" style="border-top:1px solid #555;padding:12px 0">
      <strong>${label}${optional ? " (opcional)" : ""}</strong><br>
      <label>Un único PNG spritesheet:</label>
      <input type="file" name="${key}" accept="image/png"><br>
      <img data-preview="${key}" alt="Previsualización ${label}" style="display:none;max-width:280px;max-height:180px;margin:8px 0"><br>
      <label>Columnas <input type="number" min="1" data-config="columns"></label>
      <label>Filas <input type="number" min="1" data-config="rows"></label>
      <label>Frames usados por orientación <input type="number" min="1" data-config="frames"></label>
      <label>FPS <input type="number" min="0.01" step="0.01" value="8" data-config="fps"></label><br>
      <label><input type="checkbox" ${loopsByDefault ? "checked" : ""} data-config="loop"> Bucle</label>
      <label><input type="checkbox" checked data-config="multipleOrientations"> Varias orientaciones</label>
      <label>Orden
        <select data-config="readOrder">
          <option value="row-major">Por filas</option>
          <option value="row-major-reverse">Por filas, inverso</option>
          <option value="column-major">Por columnas</option>
        </select>
      </label><br>
      <label>Orientaciones (una por fila)
        <input type="text" value="south,southWest,west,northWest,north" data-config="orientationRows">
      </label>
      <label>Orden explícito de frames (opcional)
        <input type="text" placeholder="0,1,2,3" data-config="frameOrder">
      </label>
    </div>
  `).join("");
  container.querySelectorAll('input[type="file"]').forEach(input => {
    input.addEventListener("change", () => {
      const preview = container.querySelector(`[data-preview="${input.name}"]`);
      const file = input.files?.[0];
      if (!preview || !file) return;
      preview.src = URL.createObjectURL(file);
      preview.style.display = "block";
    });
  });
  const coverInput = document.querySelector('#formCrearSkin input[name="portada"]');
  coverInput?.addEventListener("change", () => {
    const preview = document.getElementById("previewSkinPortada");
    const file = coverInput.files?.[0];
    if (!preview || !file) return;
    preview.src = URL.createObjectURL(file);
    preview.style.display = "block";
  });
  document.getElementById("cancelarEdicionSkin")?.addEventListener("click", cancelarEdicionSkin);
  container.dataset.ready = "true";
}

function configSpritesheetDesdeCampo(field) {
  const value = name => field.querySelector(`[data-config="${name}"]`);
  const frameOrder = value("frameOrder").value.split(",")
    .map(item => Number(item.trim())).filter(Number.isInteger);
  return {
    columns: Number(value("columns").value),
    rows: Number(value("rows").value),
    frames: Number(value("frames").value),
    fps: Number(value("fps").value),
    loop: value("loop").checked,
    multipleOrientations: value("multipleOrientations").checked,
    readOrder: value("readOrder").value,
    orientationRows: value("orientationRows").value.split(",")
      .map(item => item.trim()).filter(Boolean),
    frameOrder
  };
}

function cancelarEdicionSkin() {
  const form = document.getElementById("formCrearSkin");
  if (!form) return;
  form.reset();
  form.skinEditandoId.value = "";
  form.portada.required = true;
  document.getElementById("guardarSkinBtn").textContent = "Crear Skin";
  document.getElementById("cancelarEdicionSkin").style.display = "none";
  form.querySelectorAll("img").forEach(img => img.style.display = "none");
}

function editarSkin(id) {
  inicializarFormularioSkins();
  const skin = skinsAdminCache.find(item => item._id === id);
  const form = document.getElementById("formCrearSkin");
  if (!skin || !form) return;
  form.skinEditandoId.value = skin._id;
  form.titulo.value = skin.titulo || "";
  form.descripcion.value = skin.descripcion || "";
  form.precio.value = skin.precio ?? 0;
  form.renderType.value = skin.renderType || "classic";
  form.portada.required = false;
  const cover = document.getElementById("previewSkinPortada");
  cover.src = skin.portada;
  cover.style.display = "block";
  SKIN_ACTIONS.forEach(([key]) => {
    const config = skin.spritesheets?.[key];
    const field = document.querySelector(`[data-action="${key}"]`);
    if (!config || !field) return;
    Object.entries(config).forEach(([name, value]) => {
      const input = field.querySelector(`[data-config="${name}"]`);
      if (!input) return;
      if (input.type === "checkbox") input.checked = Boolean(value);
      else input.value = Array.isArray(value) ? value.join(",") : value;
    });
    const preview = field.querySelector(`[data-preview="${key}"]`);
    preview.src = config.url;
    preview.style.display = "block";
  });
  document.getElementById("guardarSkinBtn").textContent = "Guardar cambios";
  document.getElementById("cancelarEdicionSkin").style.display = "inline-block";
  form.scrollIntoView({ behavior: "smooth" });
}

// 🔄 REEMPLAZA la función renderGestionJuego COMPLETAMENTE por esto:

async function renderGestionJuego() {
  document.querySelectorAll(".seccion").forEach((s) => (s.style.display = "none"));

  const seccion = document.getElementById("gestionJuego");
  if (!seccion) {
    console.warn("❌ No se encontró la sección #gestionJuego en el DOM.");
    return;
  }

  seccion.style.display = "block";

  // 🎨 FORMULARIO CREAR SKIN
  const formSkin = document.getElementById("formCrearSkin");
  inicializarFormularioSkins();
  if (formSkin && !formSkin.dataset.listenerAdded) {
    formSkin.addEventListener("submit", async (e) => {
      e.preventDefault();

      const formData = new FormData(formSkin);
      const skinId = formSkin.skinEditandoId.value;
      if (formSkin.renderType.value === "flame_spritesheet") {
        formSkin.querySelectorAll("[data-action]").forEach(field => {
          const action = field.dataset.action;
          const file = field.querySelector('input[type="file"]').files?.[0];
          const hasExisting = Boolean(
            skinsAdminCache.find(skin => skin._id === skinId)?.spritesheets?.[action]
          );
          if (file || hasExisting) {
            formData.set(`config_${action}`, JSON.stringify(configSpritesheetDesdeCampo(field)));
          }
        });
      }

      try {
        const res = await fetch(skinId ? `/api/skins/${skinId}` : "/api/skins", {
          method: skinId ? "PUT" : "POST",
          body: formData
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        alert(skinId ? "✅ Skin actualizada correctamente" : "✅ Skin creada correctamente");
        cancelarEdicionSkin();
        cargarSkins();
      } catch (err) {
        console.error("❌ Error al guardar skin:", err);
        alert(`❌ ${err.message || "Error al guardar skin"}`);
      }
    });
    formSkin.dataset.listenerAdded = "true";
  }

  // 🛸 FORMULARIO CREAR OVNI
  const formUfo = document.getElementById("crearUfoForm");
  if (formUfo && !formUfo.dataset.listenerAdded) {
    const cancelarUfo = document.getElementById("cancelarEdicionUfo");
    cancelarUfo?.addEventListener("click", cancelarEdicionUfo);

    formUfo.addEventListener("submit", async (e) => {
      e.preventDefault();

      const formData = new FormData(formUfo);
      const esEdicion = Boolean(ufoEditandoId);

      // Validaciones mínimas de archivos
      const imagenOvni = formData.get("imagenOvni");
      const imagenBala = formData.get("imagenBala");
      if (!esEdicion && (!imagenOvni || !imagenOvni.name || imagenOvni.size === 0)) {
        alert("⚠️ Selecciona una imagen válida para el OVNI");
        return;
      }
      if (!esEdicion && (!imagenBala || !imagenBala.name || imagenBala.size === 0)) {
        alert("⚠️ Selecciona una imagen válida para la bala");
        return;
      }

      try {
        const res = await fetch(esEdicion ? `/api/ufo/${ufoEditandoId}` : "/api/ufo", {
          method: esEdicion ? "PUT" : "POST",
          body: formData
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Error al guardar el OVNI");

        alert(esEdicion
          ? "✅ OVNI actualizado correctamente"
          : "✅ OVNI creado correctamente");
        cancelarEdicionUfo();
        renderUfoManager();
      } catch (err) {
        console.error("❌ Error al guardar OVNI:", err);
        alert(`❌ ${err.message || "Error al guardar el OVNI"}`);
      }
    });

    formUfo.dataset.listenerAdded = "true";
  }
  
    // 🏪 FORMULARIO CREAR PROMOCIÓN DE NEGOCIO (admin)
  const formPromo = document.getElementById("formCrearPromocion");
  if (formPromo && !formPromo.dataset.listenerAdded) {
    formPromo.addEventListener("submit", async (e) => {
      e.preventDefault();

      const formData = new FormData(formPromo);

      // Parsear texto plano de opciones a JSON válido
      const opcionesTexto = formData.get("opcionesDuracion");
      const opciones = opcionesTexto
        .split("\n")
        .map(linea => {
          const [meses, precio] = linea.split(",").map(x => x.trim());
          return { duracionMeses: Number(meses), precioEuros: Number(precio) };
        });

      formData.set("opcionesDuracion", JSON.stringify(opciones));

      try {
        const res = await fetch("/api/promociones-negocio", {
          method: "POST",
          body: formData
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        alert("✅ Promoción creada correctamente");
        formPromo.reset();
        cargarPromocionesCreadas(); // ✅ recarga visual después de crear
        // Aquí podrías llamar a cargarPromocionesCreadas() si quieres listarlas luego
      } catch (err) {
        console.error("❌ Error al crear promoción:", err);
        alert("❌ Error al crear promoción");
      }
    });

    formPromo.dataset.listenerAdded = "true";
  }

  // 🔄 Cargar skins y cartas en la sección
  cargarSkins();
  cargarCartas();
  renderUfoManager(); // 👈 También cargar lista al iniciar esta sección
  cargarPromocionesCreadas();
}

async function cargarSkins() {
  const contenedor = document.getElementById("listaSkins");
  contenedor.innerHTML = "<p>Cargando skins...</p>";

  // ✅ Helper para asegurar que siempre se use la ruta correcta
  const toSrc = (u) => {
    if (!u) return "/img/placeholder.png"; // imagen por defecto
    if (u.startsWith("http")) return u;     // URLs absolutas externas
    if (u.startsWith("/uploads/")) return u; // caso normal en Mongo
    return `/uploads/skins/${u}`;           // fallback si solo guardaste el nombre
  };

  try {
    const res = await fetch("/api/skins");
    const skins = await res.json();
    skinsAdminCache = Array.isArray(skins) ? skins : [];

    if (!Array.isArray(skins) || skins.length === 0) {
      contenedor.innerHTML = "<p>No hay skins creadas todavía.</p>";
      return;
    }

    contenedor.innerHTML = skins.map(s => {
      const animated = s.renderType === "flame_spritesheet";
      const animationSummary = animated
        ? SKIN_ACTIONS.map(([key, label]) => {
            const config = s.spritesheets?.[key];
            if (!config) return `<li>${label}: no configurado</li>`;
            return `<li>${label}: ${config.columns}×${config.rows}, ${config.frames} frames, ${config.fps || (1 / config.frameTime).toFixed(2)} FPS</li>`;
          }).join("")
        : `
          <li>Muriendo: ${s.scripts?.muriendo?.length || 0} imágenes</li>
          <li>Moviéndose: ${s.scripts?.moviendose?.length || 0} imágenes</li>
          <li>Parado: ${s.scripts?.parado?.length || 0} imágenes</li>
          <li>Disparando: ${s.scripts?.disparando?.length || 0} imágenes</li>
          <li>Rápido: ${s.scripts?.rapido?.length || 0} imágenes</li>`;
      return `
      <div class="reward-card">
        <h4>${s.titulo}</h4>
        <p>${s.descripcion}</p>
        <img src="${toSrc(s.portada)}" alt="Portada" style="width: 150px; display:block; margin:5px 0;">
        <p>🎯 Precio: ${s.precio} Stepcoins</p>
        <p><strong>Render:</strong> ${animated ? "Flame spritesheet (v2)" : "Clásico"}</p>
        <ul>
          ${animationSummary}
        </ul>
        <button onclick="editarSkin('${s._id}')">✏️ Editar</button>
        <button onclick="eliminarSkin('${s._id}')">🗑️ Eliminar</button>
      </div>
    `;
    }).join("");

  } catch (err) {
    console.error("❌ Error al cargar skins:", err);
    contenedor.innerHTML = "<p>❌ Error al cargar las skins</p>";
  }
}


async function eliminarSkin(id) {
  if (!confirm("¿Estás seguro de que quieres eliminar esta skin?")) return;

  try {
    const res = await fetch(`/api/skins/${id}`, { method: "DELETE" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    alert("✅ Skin eliminada");
    cargarSkins();
  } catch (err) {
    console.error("❌ Error al eliminar skin:", err);
    alert("❌ Error al eliminar skin");
  }
}

async function renderSkinsCliente() {
  try {
    const res = await fetch("/api/skins");
    const skins = await res.json();

    const contenedor = document.getElementById("skinsDisponiblesCliente");
    contenedor.innerHTML = "";

    if (!skins.length) {
      contenedor.innerHTML = "<p>No hay skins disponibles.</p>";
      return;
    }

    skins.forEach(skin => {
      const div = document.createElement("div");
      div.className = "tarjeta-skin"; // Cambiado de skin-card a tarjeta-skin para estilo tipo carta
      div.innerHTML = `
        <img src="${skin.portada}" alt="${skin.titulo}" />
        <h4>${skin.titulo}</h4>
        <p>${skin.descripcion}</p>
        <p><strong>${skin.precio} 🪙</strong></p>
        <button onclick="comprarSkin('${skin._id}', ${skin.precio})">Comprar</button>
      `;
      contenedor.appendChild(div);
    });
  } catch (err) {
    console.error("❌ Error al cargar skins del cliente:", err);
  }
}

async function comprarSkin(skinId, precio) {
  if (!confirm(`¿Quieres comprar esta skin por ${precio} Stepcoins?`)) return;

  const userRaw = localStorage.getItem("user");
  if (!userRaw) {
    alert("❌ No se ha encontrado el usuario");
    return;
  }

  user = JSON.parse(userRaw); // 🔄 sin "const", usa la variable global

  try {
    const response = await fetch("/api/stepcoins/comprar-skin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: user._id,
        skinId: skinId
      })
    });

    const data = await response.json();

    if (response.ok) {
      alert("✅ Skin comprada con éxito");

      // 🔄 Recargar usuario actualizado desde el backend
      const resUser = await fetch(`/api/users/${user._id}`);
      const updatedUser = await resUser.json();
      user = updatedUser;
      localStorage.setItem("user", JSON.stringify(user));

      // 🔄 Actualizar marcador o recargar Inicio
      const seccionInicio = document.getElementById("inicio");
      if (seccionInicio && seccionInicio.style.display !== "none") {
        renderInicio(); // si está en Inicio, vuelve a renderizar todo
      } else {
        const contador = document.getElementById("stepcoinsContador");
        if (contador) {
          contador.textContent = user.stepcoins;
          contador.classList.add("parpadeo");
          setTimeout(() => contador.classList.remove("parpadeo"), 1000);
        }
      }

      await renderSkinsCliente();
    } else {
      alert("❌ " + (data.error || "Error al comprar skin"));
    }
  } catch (err) {
    console.error("❌ Error comprando skin:", err);
    alert("❌ Error interno del cliente");
  }
}

async function cargarPromocionesCreadas() {
  const contenedor = document.getElementById("listaPromocionesCreadas");
  if (!contenedor) return;

  contenedor.innerHTML = "<h3>Promociones creadas</h3>";

  try {
    const res = await fetch("/api/promociones-negocio");
    const promociones = await res.json();

    if (!Array.isArray(promociones) || promociones.length === 0) {
      contenedor.innerHTML += "<p>📭 No hay promociones creadas aún.</p>";
      return;
    }

    const lista = document.createElement("div");
    lista.style.display = "flex";
    lista.style.flexWrap = "wrap";
    lista.style.gap = "20px";

    promociones.forEach(promo => {
      const tarjeta = document.createElement("div");
      tarjeta.style.border = "1px solid #ccc";
      tarjeta.style.borderRadius = "10px";
      tarjeta.style.padding = "15px";
      tarjeta.style.width = "280px";
      tarjeta.style.background = "#fff";
      tarjeta.style.boxShadow = "2px 2px 10px rgba(0,0,0,0.1)";
      tarjeta.style.color = "#000";

            tarjeta.innerHTML = `
        <h4>${promo.titulo}</h4>
        <img src="${promo.imagen}" alt="Diseño del negocio" style="width:100%; border-radius:8px; margin-bottom:10px;" />
        <p>${promo.descripcion || "Sin descripción"}</p>
        <strong>Opciones:</strong>
        <ul style="padding-left: 20px;">
          ${promo.opcionesDuracion.map(opt => `<li>${opt.duracionMeses} mes(es) → ${opt.precioEuros} €</li>`).join("")}
        </ul>
        <small>🗓️ Disponible hasta: ${new Date(promo.fechaExpiracionMaxima).toLocaleDateString()}</small><br><br>
        <button class="btnEliminarPromo" data-id="${promo._id}" style="background:#c62828; color:white; border:none; padding:6px 12px; border-radius:6px; cursor:pointer;">🗑 Eliminar</button>
      `;
      lista.appendChild(tarjeta);
    });

        // 🎯 Listener para eliminar promociones
    setTimeout(() => {
      document.querySelectorAll(".btnEliminarPromo").forEach(btn => {
        btn.addEventListener("click", async () => {
          const id = btn.dataset.id;
          if (!confirm("¿Eliminar esta promoción?")) return;

          try {
            const res = await fetch(`/api/promociones-negocio/${id}`, {
              method: "DELETE"
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error);
            alert("✅ Promoción eliminada");
            cargarPromocionesCreadas();
          } catch (err) {
            console.error("❌ Error al eliminar promoción:", err);
            alert("❌ Error al eliminar promoción");
          }
        });
      });
    }, 100);

    contenedor.appendChild(lista);
  } catch (err) {
    console.error("❌ Error al cargar promociones creadas:", err);
    contenedor.innerHTML += "<p style='color:red;'>❌ Error al cargar promociones</p>";
  }
}

async function renderPromoLocal() {
  const seccion = document.getElementById("promoLocal");
  if (!seccion) return;
  document.querySelectorAll(".seccion").forEach(s => s.style.display = "none");
  seccion.style.display = "block";

  const contenedor = document.getElementById("contenedorPromosDisponibles");
  contenedor.innerHTML = "<p>🔄 Cargando promociones disponibles...</p>";

  try {
    const res = await fetch("/api/promociones-negocio");
    const promociones = await res.json();

    if (!Array.isArray(promociones) || promociones.length === 0) {
      contenedor.innerHTML = "<p>📭 No hay promociones disponibles actualmente.</p>";
      return;
    }

    const lista = document.createElement("div");
    lista.style.display = "flex";
    lista.style.flexWrap = "wrap";
    lista.style.gap = "20px";

    promociones.forEach(promo => {
      const tarjeta = document.createElement("div");
      tarjeta.className = "card-promo";

      const formId = `formPromo_${promo._id}`;

      tarjeta.innerHTML = `
        <h4>${promo.titulo}</h4>
        <img src="${promo.imagen}" alt="Diseño del negocio" />
        <p>${promo.descripcion || "Sin descripción"}</p>
        <form id="${formId}" enctype="multipart/form-data">
          <label>🖼️ Tu logo:</label>
          <input type="file" name="logo" accept="image/*" required>

          <label>📍 Ubicación (lat, lng):</label>
          <div style="display: flex; gap: 10px;">
            <input type="text" name="lat" placeholder="Latitud" required>
            <input type="text" name="lng" placeholder="Longitud" required>
          </div>

          <label>⏳ Duración:</label>
          <select name="duracion" required>
            <option value="">-- Selecciona --</option>
            ${promo.opcionesDuracion.map(opt =>
              `<option value="${opt.duracionMeses}">${opt.duracionMeses} mes(es) → ${opt.precioEuros} €</option>`
            ).join("")}
          </select>

          <button type="submit" style="background: #ffe100; color: #000; font-weight: bold; padding: 10px; border-radius: 6px; cursor: pointer;">📦 Contratar promoción</button>
        </form>
      `;

      // Agregar tarjeta al DOM
      lista.appendChild(tarjeta);

      // Agregar listener al formulario directamente
      const form = tarjeta.querySelector("form");
      form.addEventListener("submit", async (e) => {
        e.preventDefault();

        const formData = new FormData(form);
        const user = JSON.parse(localStorage.getItem("user")); // ✅ Carga el usuario logueado
        formData.append("promoId", promo._id);
        formData.append("userId", user._id); // ✅ Añade el ID al backend

        try {
          const res = await fetch("/api/promo-contratada", {
            method: "POST",
            body: formData
          });

          const data = await res.json();
          if (!res.ok) throw new Error(data.error);

          alert("✅ Promoción contratada correctamente");
          form.reset();
        } catch (err) {
          console.error("❌ Error al contratar promoción:", err);
          alert("❌ Error al contratar promoción");
        }
      });
    });

    contenedor.innerHTML = "";
    contenedor.appendChild(lista);

  } catch (err) {
    console.error("❌ Error al cargar promociones:", err);
    contenedor.innerHTML = "<p style='color:red;'>❌ Error al cargar promociones disponibles</p>";
  }
}

// ✅ Esto es lo que te falta — ponlo arriba del todo, antes de usarlo
class NegocioOverlay extends google.maps.OverlayView {
  constructor({ position, imagenBase, logo, map, width = 100, height = 100 }) {
    super();
    this.position = position;
    this.imagenBase = imagenBase;
    this.logo = logo;
    this.map = map;
    this.width = width;
    this.height = height;
    this.div = null;
    this.setMap(map);
  }

  onAdd() {
  this.div = document.createElement("div");
  this.div.style.position = "absolute";
  this.div.style.width = this.width + "px";
  this.div.style.height = this.height + "px";
  this.div.style.pointerEvents = "none";

  const container = document.createElement("div");
  container.style.position = "relative";
  container.style.width = "100%";
  container.style.height = "100%";

  const cargarImagenSiExiste = async (src, className = "", style = null) => {
  try {
    const res = await fetch(src, { method: "HEAD" });
    if (!res.ok) return;

    const img = new Image();
    img.src = src;
    img.className = className;
    img.style = style;
    img.onload = () => {
      container.appendChild(img);
    };
  } catch (err) {
    // No hacemos console.warn para no llenar la consola
  }
};

  // Cargar imágenes sin bloquear la ejecución del resto
  Promise.all([
    this.imagenBase
      ? cargarImagenSiExiste(
          this.imagenBase,
          "",
          "width: 100%; height: 100%; border-radius: 10px;"
        )
      : null,
    this.logo
      ? cargarImagenSiExiste(
  this.logo,
  "logo-comercio"
)
      : null,
  ]);

  this.div.appendChild(container);
  const panes = this.getPanes();
  panes.overlayMouseTarget.appendChild(this.div);
}

  draw() {
    const overlayProjection = this.getProjection();
    const pos = overlayProjection.fromLatLngToDivPixel(
      new google.maps.LatLng(this.position.lat, this.position.lng)
    );
    if (this.div) {
      this.div.style.left = pos.x - this.width / 2 + "px";
      this.div.style.top = pos.y - this.height / 2 + "px";
    }
  }

  onRemove() {
    if (this.div) {
      this.div.remove();
      this.div = null;
    }
  }
}

let negociosActivosOverlays = []; // para poder limpiarlos al refrescar

async function renderNegociosActivos(map) {
  try {
    // 🧹 1. Limpiar overlays existentes
    negociosActivosOverlays.forEach(o => o.setMap(null));
    negociosActivosOverlays = [];

    // 🧹 2. Limpiar cualquier logo colgado del DOM
    document.querySelectorAll(".logo-comercio").forEach(el => el.remove());

    // 🛰️ 3. Pedir promos activas
    const res = await fetch("/api/promo-contratada/activas");
    const contentType = res.headers.get("content-type") || "";

    if (!res.ok || !contentType.includes("application/json")) {
      const text = await res.text();
      console.error("❌ Respuesta NO JSON de /activas:", res.status, text.slice(0, 200));
      return;
    }

    const compras = await res.json();
    if (!Array.isArray(compras) || compras.length === 0) {
      console.warn("ℹ️ No hay promos activas");
      return;
    }

    // 🧠 4. Filtrar y pintar solo las válidas (con posición e imágenes)
    compras.forEach(c => {
      if (
        !c.lat || !c.lng ||
        !c.imagenBase || typeof c.imagenBase !== "string" ||
        !c.logoComercio || typeof c.logoComercio !== "string"
      ) {
        console.warn("⛔ Promo inválida omitida:", c);
        return;
      }

      const overlay = new NegocioOverlay({
        position: { lat: c.lat, lng: c.lng },
        imagenBase: c.imagenBase,
        logo: c.logoComercio,
        map,
        width: 60,
        height: 60
      });

      negociosActivosOverlays.push(overlay);
    });

  } catch (err) {
    console.error("❌ Error pintando negocios activos:", err);
  }
}

// ⏱️ Llamada con delay
setTimeout(() => {
  renderNegociosActivos(mapaUsuario);
}, 300);

async function cargarCartas() {
  try {
    const res = await fetch("/api/cards");
    const cartas = await res.json();
    if (!res.ok) throw new Error(cartas.error || "Error al cargar cartas");
    cartasGestion = cartas;

    const contenedor = document.getElementById("listaCartas");
    contenedor.innerHTML = "";

    if (!cartas.length) {
      contenedor.innerHTML = "<p>No hay cartas creadas.</p>";
      return;
    }

    cartas.forEach(carta => {
      const div = document.createElement("div");
      div.className = "carta-item";

      div.innerHTML = `
        <h4>${carta.titulo}</h4>
        ${carta.imagenPortada ? `<img src="${carta.imagenPortada}" alt="Portada">` : ""}
        <p>${carta.descripcion || "Sin descripción"}</p>
        <p><strong>Tipo:</strong> ${carta.tipoArma}</p>
        ${carta.tipoArma === "Proyectil" ? `<p><strong>Alcance:</strong> ${carta.alcance}m</p>` : ""}
        <p><strong>Daño:</strong> ${carta.dano}</p>
        <p><strong>Dispositivo:</strong> ${carta.dispositivo || "Ambos"}</p>
        <p><strong>Tiempo de espera:</strong> ${carta.tiempoEspera || 0} segundos</p>
        <button onclick="editarCarta('${carta._id}')">✏️ Editar</button>
        <button onclick="eliminarCarta('${carta._id}')">🗑️ Eliminar</button>
      `;

      contenedor.appendChild(div);
    });
  } catch (err) {
    console.error("❌ Error al cargar cartas:", err);
  }
}

function editarCarta(id) {
  const carta = cartasGestion.find((item) => item._id === id);
  if (!carta || typeof window.prepararFormularioCartaEdicion !== "function") return;
  window.prepararFormularioCartaEdicion(carta);
}

async function eliminarCarta(id) {
  if (!confirm("¿Estás seguro de que quieres eliminar esta carta?")) return;

  try {
    const res = await fetch(`/api/cards/${id}`, {
      method: "DELETE",
    });

    if (res.ok) {
      alert("✅ Carta eliminada");
      await cargarCartas();
    } else {
      alert("❌ Error al eliminar carta");
    }
  } catch (err) {
    console.error("❌ Error eliminando carta:", err);
    alert("❌ Error de red");
  }
}

async function cargarCartasCliente() {
  const contenedor = document.getElementById("misCartasContainer");
  if (!contenedor) return;

  contenedor.innerHTML = "<p>Cargando cartas...</p>";

  try {
    const res = await fetch(`/api/cards/user-cards/${user._id}`);
    if (!res.ok) throw new Error("Error al cargar cartas");

    const cartas = await res.json();

    if (!cartas.length) {
      contenedor.innerHTML = "<p>🎴 Aún no has ganado ninguna carta</p>";
      return;
    }

    contenedor.innerHTML = ""; // limpiar

    cartas.forEach(carta => {
      const cardEl = document.createElement("div");
      cardEl.className = "carta-ganada";
      cardEl.innerHTML = `
        <img src="${carta.imagenPortada}" alt="${carta.titulo}" class="carta-imagen">
        <p>${carta.titulo}</p>
      `;
      contenedor.appendChild(cardEl);
    });

  } catch (err) {
    console.error("❌ Error cargando cartas:", err);
    contenedor.innerHTML = "<p>Error al cargar tus cartas</p>";
  }
}

let currentRotation = 0;
let isSpinning = false;

const options = [
  "Tira de nuevo",        // 0
  "20000 Stepcoins",      // 1
  "Nada",                 // 2
  "500 Stepcoins",        // 3
  "Carta aleatoria",      // 4
  "Juego de cultura"      // 5
];

const rotationPerSlice = 360 / options.length;

function obtenerIndiceResultadoRuleta() {
  const weightedOptions = [
    { label: "Tira de nuevo", weight: 10 },
    { label: "20000 Stepcoins", weight: 5 },
    { label: "Nada", weight: 30 },
    { label: "500 Stepcoins", weight: 20 },
    { label: "Carta aleatoria", weight: 20 },
    { label: "Juego de cultura", weight: 15 }
  ];

  const total = weightedOptions.reduce((acc, o) => acc + o.weight, 0);
  const r = Math.random() * total;
  let acumulado = 0;
  for (let i = 0; i < weightedOptions.length; i++) {
    acumulado += weightedOptions[i].weight;
    if (r < acumulado) return i;
  }
  return 0;
}

function inicializarRuleta() {
  const roulette = document.getElementById('roulette');
  if (!roulette) return;
  roulette.innerHTML = '';

  options.forEach((option, index) => {
    const slice = document.createElement('div');
    slice.className = 'slice';
    slice.style.transform = `rotate(${rotationPerSlice * index}deg)`;
    slice.style.backgroundColor = index % 2 === 0 ? '#2e7d32' : '#1b5e20';

    const text = document.createElement('div');
    text.textContent = option;
    text.style.transform = `rotate(-${rotationPerSlice * index}deg) translate(60px, 10px)`;
    text.style.transformOrigin = 'center center';
    text.style.color = 'white';
    text.style.fontSize = '12px';
    text.style.fontWeight = 'bold';
    text.style.textAlign = 'center';
    text.style.width = '100px';
    text.style.position = 'absolute';
    text.style.left = '0';
    text.style.top = '50%';

    slice.appendChild(text);
    roulette.appendChild(slice);
  });

  // ❌ Quitar cualquier compensación de rotación inicial
  roulette.style.transform = `rotate(0deg)`;
}

document.addEventListener("click", async (e) => {
  if (e.target.id === "spinButton") {
    if (isSpinning) return;

    if (user.stepcoins < 500) {
      alert("❌ No tienes suficientes Stepcoins");
      return;
    }

    isSpinning = true;
    e.target.disabled = true;

    const display = document.getElementById("resultDisplay");
    if (display) display.textContent = "🎯 Girando...";

    // Resultado lógico
    const indexFinal = obtenerIndiceResultadoRuleta();
    const resultadoFinal = options[indexFinal];

    // 🧠 Ángulo por porción
    const sliceAngle = 360 / options.length;

    // 👉 Ángulo al centro del slice
    const angleToSliceCenter = sliceAngle * indexFinal + sliceAngle / 2;

    // 🎯 Total con vueltas extra
    const totalRotation = 360 * 5 + angleToSliceCenter;

    // Animar ruleta
    const roulette = document.getElementById("roulette");
    if (roulette) {
      roulette.style.transition = "transform 5s ease-out";
      roulette.style.transform = `rotate(${totalRotation}deg)`;
    }

    // Esperar que termine la animación
    setTimeout(async () => {
      if (display) display.textContent = `🎁 Resultado: ${resultadoFinal}`;
      await procesarResultadoRuleta(resultadoFinal);

      // ❗ Dejar ruleta fija en el sector correcto
      if (roulette) {
        roulette.style.transition = "none";
        roulette.style.transform = `rotate(${angleToSliceCenter}deg)`;
      }

      isSpinning = false;
      e.target.disabled = false;
    }, 5100);
  }
});


async function procesarResultadoRuleta(resultado) {
  try {
    const res = await fetch("/api/stepcoins/ruleta", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: user._id, resultado })
    });

    const data = await res.json();

    if (res.ok) {
      // 🎯 SI ES JUEGO DE CULTURA → abrir popup y salir
      if (resultado === "Juego de cultura") {
        window.open(
          `/juego-cultura.html?userId=${user._id}`,
          "_blank",
          "width=500,height=700"
        );
        return;
      }

      alert("✅ Resultado procesado: " + resultado);

      // 🔄 Actualizar Stepcoins en UI
      user.stepcoins = data.nuevosStepcoins;
      localStorage.setItem("user", JSON.stringify(user));
      const contador = document.getElementById("stepcoinsContador");
      if (contador) contador.textContent = user.stepcoins;

      // 🃏 Añadir nueva carta si la hay
      if (data.nuevaCarta) {
        // Render en listaCartas (si existe)
        const lista = document.getElementById("listaCartas");
        if (lista) {
          const div = document.createElement("div");
          div.className = "carta";
          div.innerHTML = `
            <img src="${data.nuevaCarta.imagen}" alt="${data.nuevaCarta.titulo}">
            <p><strong>${data.nuevaCarta.titulo}</strong></p>
          `;
          lista.appendChild(div);
        }

        // Render en misCartasContainer (CRS)
        const misCartas = document.getElementById("misCartasContainer");
        if (misCartas) {
          const div = document.createElement("div");
          div.className = "carta";
          div.innerHTML = `
            <img src="${data.nuevaCarta.imagen}" alt="${data.nuevaCarta.titulo}">
            <p><strong>${data.nuevaCarta.titulo}</strong></p>
          `;
          misCartas.appendChild(div);
        }
      }
    } else {
      alert("❌ " + (data.error || "Error al procesar resultado"));
    }
  } catch (err) {
    console.error("❌ Error al comunicar con el servidor:", err);
    alert("❌ Error de red al procesar la ruleta");
  }
}

let rotacion = 0;

function crearEtiquetas(opciones) {
  const ruleta = document.querySelector(".ruleta");
  ruleta.innerHTML = ""; // Limpia etiquetas anteriores

  const numSectores = opciones.length;
  const anguloPorSector = 360 / numSectores;

  // Fondo visual en conic-gradient
  ruleta.style.background = `conic-gradient(
    #2e9e4d 0deg ${anguloPorSector}deg,
    #1e7c3d ${anguloPorSector}deg ${2 * anguloPorSector}deg,
    #2e9e4d ${2 * anguloPorSector}deg ${3 * anguloPorSector}deg,
    #1e7c3d ${3 * anguloPorSector}deg ${4 * anguloPorSector}deg,
    #2e9e4d ${4 * anguloPorSector}deg ${5 * anguloPorSector}deg,
    #1e7c3d ${5 * anguloPorSector}deg 360deg
  )`;

  opciones.forEach((texto, i) => {
    const label = document.createElement("div");
    label.className = "etiqueta-sector";
    label.textContent = texto;

    const angulo = i * anguloPorSector;
    label.style.transform = `rotate(${angulo}deg) translate(130px) rotate(-${angulo}deg)`;

    ruleta.appendChild(label);
  });
}


const estiloMapaSoluchion = [

  // 1. Fondo general urbano en marrón claro
  {
    elementType: "geometry",
    stylers: [{ color: "#f1e6d6" }] // marrón pastel tipo arena
  },

  // 2. Parques con efecto césped cartoon + contorno
  {
    featureType: "poi.park",
    elementType: "geometry",
    stylers: [{ color: "#6fbf73" }]
  },
  {
    featureType: "poi.park",
    elementType: "geometry.stroke",
    stylers: [{ color: "#005800" }, { weight: 1.2 }]
  },

  // 3. Ríos con efecto cel shading + contorno
  {
    featureType: "water",
    elementType: "geometry",
    stylers: [{ color: "#1e90ff" }]
  },
  {
    featureType: "water",
    elementType: "geometry.stroke",
    stylers: [{ color: "#003f7f" }, { weight: 1 }]
  },

  // 4. Calles marrón oscuro + borde negro grueso
  {
    featureType: "road",
    elementType: "geometry",
    stylers: [{ color: "#5c3a1d" }]
  },
  {
    featureType: "road",
    elementType: "geometry.stroke",
    stylers: [{ color: "#000000" }, { weight: 1.5 }]
  },

  // 5. POIs (edificios especiales) en verde neón con borde
  {
    featureType: "poi",
    elementType: "geometry",
    stylers: [{ color: "#00e676" }]
  },
  {
    featureType: "poi",
    elementType: "geometry.stroke",
    stylers: [{ color: "#005c2e" }, { weight: 1 }]
  },

  // 6. Paradas de bus/bici en cyan neón
  {
    featureType: "transit",
    elementType: "labels.icon",
    stylers: [{ visibility: "on" }, { color: "#00ffff" }]
  },

  // 7. Texto de calles con fuente tipo pixel – blanco con contorno grueso negro
  {
    elementType: "labels.text.fill",
    stylers: [{ color: "#ffffff" }]
  },
  {
    elementType: "labels.text.stroke",
    stylers: [{ color: "#000000" }, { weight: 4 }]
  },

  // 8. Zonas artificiales en gris verdoso suave + contorno
  {
    featureType: "landscape.man_made",
    elementType: "geometry",
    stylers: [{ color: "#ddeedd" }]
  },
  {
    featureType: "landscape.man_made",
    elementType: "geometry.stroke",
    stylers: [{ color: "#999999" }, { weight: 0.8 }]
  },

  // 9. Ocultar POIs innecesarios
  {
    featureType: "poi.business",
    stylers: [{ visibility: "off" }]
  },
  {
    featureType: "poi.school",
    stylers: [{ visibility: "off" }]
  },
  {
    featureType: "poi.medical",
    stylers: [{ visibility: "off" }]
  },
  {
    featureType: "poi.place_of_worship",
    stylers: [{ visibility: "off" }]
  },

  // 10. Contraste general mejorado
  {
    elementType: "geometry",
    stylers: [{ saturation: 10 }, { lightness: -5 }]
  },

  // Zonas naturales tipo parque (algunas salen como "landscape.natural")
{
  featureType: "landscape.natural",
  elementType: "geometry",
  stylers: [{ color: "#6fbf73" }] // mismo color de césped cartoon
},
{
  featureType: "landscape.natural",
  elementType: "geometry.stroke",
  stylers: [{ color: "#005800" }, { weight: 1.2 }]
},

]

function aplicarSkin(skin, motivo = "") {
  if (!marcadorUsuario) {
    console.warn("⚠️ No hay marcadorUsuario definido aún.");
    return;
  }

  const user = JSON.parse(localStorage.getItem("user"));
  const userId = user?._id;

  if (!userId) {
    console.error("❌ No se encontró userId");
    return;
  }

  marcadorUsuario.setIcon({
    url: skin.scripts.parado?.[0],
    scaledSize: new google.maps.Size(48, 48),
  });

  console.log(`🎭 Skin aplicada (${motivo}):`, skin.scripts.parado?.[0]);

  // 🔁 Enviar al backend
  fetch(`/api/users/${userId}/skin`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ skinId: skin._id })
  })
    .then(response => response.json())
    .then(data => {
      if (data.error) {
        console.error("❌ Error al asignar skin:", data.error);
      } else {
        console.log("✅ Skin guardada en backend:", data.skinSeleccionada);
      }
    })
    .catch(err => {
      console.error("❌ Error al hacer fetch:", err);
    });
}


async function abrirPopupSeleccionSkins() {
  const userRaw = localStorage.getItem("user");
  if (!userRaw) return;
  const user = JSON.parse(userRaw);
  const skins = user.skinsCompradas || [];

  if (!skins.length) {
    alert("❌ No has comprado skins todavía.");
    return;
  }

  // 🧱 Fondo difuminado
  const overlay = document.createElement("div");
  overlay.id = "overlayFondoSkins";

  // 🧩 Contenedor popup
  const popup = document.createElement("div");
  popup.id = "popupSkins";

  // HTML base
  popup.innerHTML = `
    <h3>Selecciona tu skin</h3>
    <div id="gridSkins"></div>
    <button id="cerrarPopupSkins">Cerrar</button>
  `;

  document.body.appendChild(overlay);
  document.body.appendChild(popup);

  const grid = popup.querySelector("#gridSkins");

  skins.forEach(skin => {
    const div = document.createElement("div");
    div.className = "skinOpcion";

    // Marca visual si es la seleccionada actualmente
    if (user.skinSeleccionada?._id === skin._id) {
      div.classList.add("seleccionada");
    }

    div.innerHTML = `
      <img src="${skin.portada}" alt="${skin.titulo}">
      <p style="text-align:center;">${skin.titulo}</p>
    `;

    div.onclick = () => {
    user.skinSeleccionada = skin;
    localStorage.setItem("user", JSON.stringify(user));
    localStorage.setItem("skinSeleccionada", JSON.stringify(skin));

    aplicarSkin(skin, "selección manual"); // 👈 AQUÍ EL CAMBIO

    document.body.removeChild(popup);
    document.body.removeChild(overlay);
   };

    grid.appendChild(div);
  });

  document.getElementById("cerrarPopupSkins").onclick = () => {
    document.body.removeChild(popup);
    document.body.removeChild(overlay);
  };
}

function iniciarGeolocalizacion(callbackCuandoListo) {
  navigator.geolocation.watchPosition(
  (pos) => {
    miPosicion = {
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
    };
    console.log("📍 Posición actual:", miPosicion);
    if (callbackCuandoListo) {
      callbackCuandoListo();
      callbackCuandoListo = null; // Solo una vez
    }
  },
  (err) => {
    console.warn("❌ Error geolocalización:", err);
    intentosGeo++;
    if (intentosGeo < 5) {
      console.log(`🔁 Reintentando geolocalización (${intentosGeo})...`);
      setTimeout(() => iniciarGeolocalizacion(callbackCuandoListo), 5000); // 🔁 Dale más margen
    } else {
      alert("No se pudo obtener la ubicación. Activa el GPS o los permisos.");
    }
  },
  {
    enableHighAccuracy: true,
    maximumAge: 10000, // 🔁 permite usar una posición reciente
    timeout: 15000, // ⏱️ aumenta el tiempo de espera
  }
);
}

function esperarElemento(id, maxIntentos = 10, intervalo = 100) {
  return new Promise((resolve, reject) => {
    let intentos = 0;
    const checker = setInterval(() => {
      const el = document.getElementById(id);
      if (el) {
        clearInterval(checker);
        resolve(el);
      } else if (++intentos >= maxIntentos) {
        clearInterval(checker);
        reject("⛔ No se encontró el elemento: " + id);
      }
    }, intervalo);
  });
}

async function renderVisionDios() {
  if (!miPosicion) {
    console.warn("⏳ Esperando posición para iniciar el mapa...");
    return;
  }

  const userRaw = localStorage.getItem("user");
  if (!userRaw) return;
  usuario = JSON.parse(userRaw);

  mapaUsuario = new google.maps.Map(document.getElementById("mapaUsuario"), {
    center: miPosicion,
    zoom: 17,
    minZoom: 17,        
    maxZoom: 17, 
    styles: estiloMapaSoluchion,
    disableDefaultUI: true,      // ✅ Esto quita todos los controles (zoom, satélite, Street View, etc.)
    gestureHandling: "greedy",   // Opcional: permite tocar y arrastrar sin restricciones
    zoomControl: false,          // Extra: por si deseas controlar más fino
    fullscreenControl: false,    // Extra
    streetViewControl: false,    // Extra
    mapTypeControl: false,       // Extra
  });

  map = mapaUsuario;
  await renderNegociosActivos(mapaUsuario);

// 🧍‍♂️ Usuario actual
try {
  userData = JSON.parse(userRaw);
  if (!userData || !userData._id) {
    console.warn("⚠️ No se encontró userData o falta el _id");
    return;
  }
} catch (err) {
  console.error("❌ Error al parsear userData:", err);
  return;
}

// 🟢 Obtener la skin seleccionada (de localStorage) o asignar una aleatoria
let skinSeleccionada = null;
const skinGuardada = localStorage.getItem("skinSeleccionada");

if (skinGuardada) {
  try {
    skinSeleccionada = JSON.parse(skinGuardada);
  } catch (e) {
    console.warn("⚠️ Error al parsear skin guardada:", e);
  }
}

// Si no hay ninguna guardada, asignar aleatoria
if (!skinSeleccionada && userData?.skinsCompradas?.length) {
  const res = await fetch("/api/skins");
  const skins = await res.json();
  const skinsCompradas = skins.filter(s => userData.skinsCompradas.includes(s._id));

  skinSeleccionada = skinsCompradas[Math.floor(Math.random() * skinsCompradas.length)];
  localStorage.setItem("skinSeleccionada", JSON.stringify(skinSeleccionada));
  guardarSkinEnBackend(skinSeleccionada._id);
  localStorage.setItem("skinSeleccionada", JSON.stringify(skinSeleccionada));
  console.log("🧠 Skin seleccionada (frontend):", skinSeleccionada);
  guardarSkinEnBackend(skinSeleccionada._id);
}

// ✅ Siempre aseguramos que estas variables globales estén definidas
skinParadoActualUrl = skinSeleccionada?.scripts?.parado?.[0] || "/img/fallback.png";
skinMuriendoActualUrl = skinSeleccionada?.scripts?.muriendo?.[0] || null;

// ✅ También lo metemos en userData para persistencia coherente
userData.skinSeleccionada = skinSeleccionada;
userData.skinParadoUrl = skinParadoActualUrl;
userData.skinMuriendoUrl = skinMuriendoActualUrl;

// ✅ Guardar en localStorage
localStorage.setItem("user", JSON.stringify(userData));

const skinParado = skinSeleccionada?.scripts?.parado?.[0] || "/img/fallback.png";
const skinMuriendo = skinSeleccionada?.scripts?.muriendo?.[0] || null;

skinParadoActualUrl = skinParado;
skinMuriendoActualUrl = skinMuriendo;

let skinUrl = skinParadoActualUrl;

// Primero creamos el marcador con fallback temporal
  marcadorUsuario = new google.maps.Marker({
  position: miPosicion,
  map: mapaUsuario,
  icon: {
    url: skinUrl,
    scaledSize: new google.maps.Size(48, 48)
  },
  title: "Tu ubicación",
  zIndex: 1000 // puedes ponerlo así para asegurarte
});

google.maps.event.addListener(marcadorUsuario, 'dblclick', () => {
  abrirPopupSeleccionSkins();
});

// 🧠 Añadir nombre del usuario y barra de vida sobre la skin
const overlayUsuario = new google.maps.OverlayView();
overlayUsuario.onAdd = function () {
  const layer = document.createElement("div");
  layer.className = "overlay-usuario";

  const nombre = document.createElement("div");
  nombre.className = "nombre-usuario";
  nombre.innerText = userData.nombre || "Usuario";

  const barra = document.createElement("div");
  barra.className = "barra-vida";
  const inner = document.createElement("div");
  inner.className = "vida-inner";
  inner.style.width = "100%";
  barra.appendChild(inner);

  layer.appendChild(nombre);
  layer.appendChild(barra);
  this.div = layer;

  const panes = this.getPanes();
  panes.overlayMouseTarget.appendChild(layer);
};

overlayUsuario.draw = function () {
  const projection = this.getProjection();
  const pos = projection.fromLatLngToDivPixel(marcadorUsuario.getPosition());
  if (this.div) {
    this.div.style.position = "absolute";
    this.div.style.left = `${pos.x - 30}px`; // centrado aproximado
    this.div.style.top = `${pos.y - 85}px`; // encima de la skin
  }
};

overlayUsuario.onRemove = function () {
  if (this.div) {
    this.div.parentNode.removeChild(this.div);
    this.div = null;
  }
};

overlayUsuario.setMap(mapaUsuario);

try {
  const barra = await esperarElemento("barraVida");
  const resVida = await fetch(`/api/life/${userData._id}`);
  if (resVida.ok) {
    const datos = await resVida.json();
    actualizarBarraVida(datos.vida);
  }
} catch (e) {
  console.warn("❌ No se pudo cargar la barra de vida:", e);
}

// ✅ Obtener vida real del backend y actualizar la barra
try {
  const resVida = await fetch(`/api/life/${userData._id}`);
  if (resVida.ok) {
    const datos = await resVida.json();
    const vidaActual = datos.vida;
    actualizarBarraVida(vidaActual); // ✅ ajusta visualmente la barra
  } else {
    console.warn("⚠️ No se pudo obtener la vida inicial del usuario");
  }
} catch (err) {
  console.error("❌ Error al obtener la vida inicial:", err);
}

// Verificamos si la imagen de skin se carga correctamente
if (skinUrl !== "/img/fallback.png") {
  const img = new Image();
  img.onload = () => {
    marcadorUsuario.setIcon({
      url: skinUrl,
      scaledSize: new google.maps.Size(48, 48)
    });
  };
  img.onerror = () => {
    console.warn("❌ Error al cargar la skin, usando fallback.");
    marcadorUsuario.setIcon({
      url: "/img/fallback.png",
      scaledSize: new google.maps.Size(48, 48)
    });
  };
  img.src = skinUrl; // ⬅️ importante: esto va después de los handlers
}

// Posición en tiempo real
navigator.geolocation.watchPosition((pos) => {
  miPosicion = {
    lat: pos.coords.latitude,
    lng: pos.coords.longitude,
  };
  marcadorUsuario.setPosition(miPosicion);
});

// Recentra el mapa automáticamente después de arrastrar
let recenterTimeout;
mapaUsuario.addListener("dragstart", () => {
  if (recenterTimeout) clearTimeout(recenterTimeout);
});

mapaUsuario.addListener("dragend", () => {
  recenterTimeout = setTimeout(() => {
    if (miPosicion) {
      mapaUsuario.panTo(miPosicion);
      console.log("🎯 Recentrando en:", miPosicion);
    }
  }, 1000);
});

  const res = await fetch(`/api/cards/user-cards/${user._id}`);
  if (!res.ok) {
    console.error("❌ Error al cargar cartas del usuario");
    return;
  }

  const cartas = await res.json();

  // 🔁 Obtenemos los IDs del mazo guardado
  const resMazo = await fetch(`/api/cards/user-cards/${user._id}/mazo`);
  let mazoIds = [];
  if (resMazo.ok) {
    const datos = await resMazo.json();
    mazoIds = datos.map(m => m._id); // solo los IDs
  }

  // 💡 Si el usuario aún no tiene mazo guardado, usamos los 4 primeros
  let mazo = cartas.filter(c => mazoIds.includes(c._id));
  if (mazo.length === 0) {
    mazo = cartas.slice(0, 4);
  }

  const mochila = cartas.filter(c => !mazo.some(m => m._id === c._id));

  const mazoDiv = document.getElementById("mazoActivo");
  const mochilaDiv = document.getElementById("mochilaCartas");

  function actualizarUI() {
    mazoDiv.innerHTML = "";
    mochilaDiv.innerHTML = "";

    mazo.forEach(carta => {
      const div = crearCartaHTML(carta, true);
      mazoDiv.appendChild(div);
    });

    mochila.forEach(carta => {
      const div = crearCartaHTML(carta, false);
      mochilaDiv.appendChild(div);
    });
  }

  function iniciarCooldown() {
    puedeCambiarCarta = false;
    alert("⏳ Espera 30 segundos para volver a cambiar una carta");
    cooldownTimeout = setTimeout(() => {
      puedeCambiarCarta = true;
      alert("✅ Ya puedes cambiar cartas de nuevo");
    }, 30000);
  }

  function actualizarBotonFlotante() {
  const contenedor = document.getElementById("contenedorMazo");
  if (!contenedor) return;

  contenedor.innerHTML = "";

  mazo.forEach(carta => {
    const div = document.createElement("div");
    div.className = "carta-mazo";
    div.style.width = "70px";
    div.style.cursor = "pointer";
    div.style.borderRadius = "8px";
    div.style.overflow = "hidden";
    div.style.transition = "transform 0.2s ease";

    div.innerHTML = `
      <img src="${carta.imagenPortada}" alt="${carta.titulo}" style="width:100%; border-radius: 6px;">
    `;

    div.onclick = () => {
  if (div.dataset.cooldown === "true") {
    alert("⏳ Espera antes de volver a usar esta carta");
    return;
  }

  // 💚 Eliminar borde anterior (si había)
  document.querySelectorAll("#contenedorMazo .carta-mazo").forEach(el => {
    el.style.border = "none";
  });

  // 💚 Aplicar borde a la carta seleccionada
  div.style.border = "3px solid lime";

  cartaSeleccionada = carta;
  console.log("🧠 cartaSeleccionada COMPLETA:", carta);
  console.log(`⚔️ Carta usada: ${carta.titulo} (${carta.tipoArma})`);
  cartaSeleccionadaDiv = div;

  if (carta.tipoArma !== "Proyectil") {
    alert("❌ Esta carta no es de tipo Proyectil");
    return;
  }

listenerMouseDown = mapaUsuario.addListener("mousedown", (e) => {
  const skinLatLng = marcadorUsuario.getPosition();
  const clickLatLng = e.latLng;

  const distancia = google.maps.geometry.spherical.computeDistanceBetween(clickLatLng, skinLatLng);
  if (distancia > 80) {
    alert("📍 Toca más cerca de tu skin para iniciar el disparo");
    return;
  }

  mapaUsuario.setOptions({ draggable: false });
  inicioDrag = clickLatLng;

  if (overlayArrow) {
    overlayArrow.setMap(null);
    overlayArrow = null;
  }

  overlayArrow = new ArrowOverlay(skinLatLng, 0);
  overlayArrow.setMap(mapaUsuario);
});

listenerMouseMove = mapaUsuario.addListener("mousemove", (e) => {
  if (!inicioDrag || !overlayArrow) return;

  const destino = e.latLng;
  const heading = google.maps.geometry.spherical.computeHeading(inicioDrag, destino);
  overlayArrow.setAngle(heading);
});

listenerMouseUp = mapaUsuario.addListener("mouseup", (e) => {
  if (!inicioDrag) return;

  const finDrag = e.latLng;
  const origen = marcadorUsuario.getPosition();
  const angulo = google.maps.geometry.spherical.computeHeading(inicioDrag, finDrag);
  const anguloInverso = (angulo + 180) % 360;
  const alcance = typeof cartaSeleccionada?.alcance === "number" ? cartaSeleccionada.alcance : 100;
  const destino = google.maps.geometry.spherical.computeOffset(origen, alcance, anguloInverso);

  const imagenProyectil = obtenerImagenArma(cartaSeleccionada);

  arrancarTemporizadorOvniSiHaceFalta();

  if (overlayArrow) {
    overlayArrow.setMap(null);
    overlayArrow = null;
  }

  dispararProyectil(origen, destino, imagenProyectil, cartaSeleccionada);
  mapaUsuario.setOptions({ draggable: true });
  inicioDrag = null;

  // Cooldown visual
  div.dataset.cooldown = "true";
  const overlayCooldown = document.createElement("div");
  overlayCooldown.style.position = "absolute";
  overlayCooldown.style.top = "0";
  overlayCooldown.style.left = "0";
  overlayCooldown.style.width = "100%";
  overlayCooldown.style.height = "100%";
  overlayCooldown.style.background = "rgba(0,0,0,0.6)";
  overlayCooldown.style.color = "white";
  overlayCooldown.style.fontSize = "12px";
  overlayCooldown.style.display = "flex";
  overlayCooldown.style.alignItems = "center";
  overlayCooldown.style.justifyContent = "center";
  overlayCooldown.style.borderRadius = "6px";
  overlayCooldown.innerText = `${carta.tiempoEspera}s`;
  div.style.position = "relative";
  div.appendChild(overlayCooldown);

  let segundos = carta.tiempoEspera;
  const countdown = setInterval(() => {
    segundos--;
    if (segundos <= 0) {
      clearInterval(countdown);
      div.removeChild(overlayCooldown);
      div.dataset.cooldown = "false";
    } else {
      overlayCooldown.innerText = `${segundos}s`;
    }
  }, 1000);

  // ✅ Quitar borde aunque no haya carta
  if (cartaSeleccionadaDiv) {
  cartaSeleccionadaDiv.style.border = "none";
  cartaSeleccionadaDiv = null;
  }

  // ❌ Limpiar selección después de usarla
  cartaSeleccionada = null;

  // 🔥 LIMPIAMOS LOS LISTENERS
  if (listenerMouseDown) google.maps.event.removeListener(listenerMouseDown);
  if (listenerMouseMove) google.maps.event.removeListener(listenerMouseMove);
  if (listenerMouseUp) google.maps.event.removeListener(listenerMouseUp);

  listenerMouseDown = null;
  listenerMouseMove = null;
  listenerMouseUp = null;
});

      div.style.transform = "scale(1.1)";
      setTimeout(() => div.style.transform = "scale(1)", 200);
    };

    contenedor.appendChild(div);
  });
}

  function crearCartaHTML(carta, esMazo) {
    const div = document.createElement("div");
    div.className = "carta";
    div.dataset.id = carta._id;
    div.dataset.zona = esMazo ? "mazo" : "mochila";
    div.draggable = true;
    div.style.border = esMazo ? "2px solid lime" : "1px solid gray";
    div.style.borderRadius = "10px";
    div.style.padding = "8px";
    div.style.margin = "5px";
    div.style.background = "#222";
    div.style.color = "white";
    div.style.width = "120px";
    div.style.cursor = "grab";

    div.innerHTML = `
      <img src="${carta.imagenPortada}" alt="${carta.titulo}" style="width:100%; border-radius: 6px;"><br>
      <strong>${carta.titulo}</strong><br>
      <small>${carta.descripcion}</small><br>
      <span>🗡️ ${carta.dano} / 🎯 ${carta.alcance ?? "-"} / ♻️ ${carta.tiempoEspera}s</span>
    `;

    div.addEventListener("dragstart", () => {
      if (!puedeCambiarCarta) {
        alert("⏳ Espera 30 segundos antes de hacer otro cambio");
        return;
      }
      cartaArrastrada = { carta, esMazo };
    });

    div.addEventListener("dragover", (e) => {
      e.preventDefault();
    });

    div.addEventListener("drop", () => {
      if (!puedeCambiarCarta || !cartaArrastrada) return;

      if (cartaArrastrada.esMazo !== esMazo) {
        const desde = cartaArrastrada.esMazo ? mazo : mochila;
        const hacia = esMazo ? mazo : mochila;

        if (hacia.some(c => c._id === cartaArrastrada.carta._id)) {
          alert("❌ Esa carta ya está en esa zona");
          return;
        }

        const idxDrop = (esMazo ? mazo : mochila).findIndex(c => c._id === carta._id);
        const idxDrag = desde.findIndex(c => c._id === cartaArrastrada.carta._id);

        if (idxDrop !== -1 && idxDrag !== -1) {
  const cartaTemp = hacia[idxDrop];
  hacia[idxDrop] = cartaArrastrada.carta;
  desde[idxDrag] = cartaTemp;

  actualizarUI();
  actualizarBotonFlotante(); // 🔁 Actualiza el contenedor del mazo flotante
  iniciarCooldown();
  cargarUfosEnMapa(mapaUsuario, miPosicion);

  // ✅ Guardar automáticamente el nuevo mazo
  if (mazo.length === 4) {
    fetch(`/api/cards/user-cards/${user._id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mazo: mazo.map(c => c._id) })
    }).then(res => {
      if (!res.ok) {
        console.warn("❌ No se pudo guardar el mazo automáticamente");
      } else {
        console.log("✅ Mazo actualizado automáticamente");
      }
    }).catch(err => {
      console.error("❌ Error al guardar mazo:", err);
    });
  }
}
      }

      cartaArrastrada = null;
    });

    return div;
  }

  actualizarUI();

class ArrowOverlay extends google.maps.OverlayView {
  constructor(position, angle) {
    super();
    this.position = position;
    this.angle = angle;
    this.div = null;
  }

  onAdd() {
    this.div = document.createElement("div");
    this.div.style.position = "absolute";
    this.div.style.width = "60px";
    this.div.style.height = "60px";
    this.div.style.backgroundImage = "url('/img/arrow.png')";
    this.div.style.backgroundSize = "contain";
    this.div.style.transform = `rotate(${this.angle}deg)`;
    this.div.style.transformOrigin = "center center";
    this.div.style.zIndex = "1000";

    const panes = this.getPanes();
    panes.overlayImage.appendChild(this.div);
  }

  draw() {
    const projection = this.getProjection();
    const point = projection.fromLatLngToDivPixel(this.position);
    if (point && this.div) {
      this.div.style.left = point.x - 30 + "px";
      this.div.style.top = point.y - 30 + "px";
    }
  }

  onRemove() {
    if (this.div && this.div.parentNode) {
      this.div.parentNode.removeChild(this.div);
      this.div = null;
    }
  }

  setAngle(angle) {
    this.angle = angle;
    if (this.div) {
      this.div.style.transform = `rotate(${angle+120}deg)`;
    }
  }

  setPosition(position) {
    this.position = position;
    this.draw();
  }
}

  // 🌍 Visibilidad en el mapa: botón "Hacerme visible"
let intervaloVisibilidad;

const btnVisibilidad = document.getElementById("btnVisibilidad");

if (btnVisibilidad && !intervaloVisibilidad) {
  btnVisibilidad.onclick = async () => {
  if (compartiendoUbicacion) {
  detenerCompartirUbicacion();
  compartiendoUbicacion = false;
  btnVisibilidad.innerText = "Hacerme visible";

  // 👇 Ocultar elementos del mazo
  document.getElementById("botonCartas").style.display = "none";
  document.getElementById("contenedorMazo").style.display = "none";

  alert("🛑 Has dejado de compartir ubicación");
  return;
}

  await compartirUbicacion(); // Envío inicial
intervaloUbicacion = setInterval(compartirUbicacion, 5000);
compartiendoUbicacion = true;
btnVisibilidad.innerText = "Ocultar visibilidad";

// ✅ Mostrar botón y mazo
actualizarBotonFlotante();
document.getElementById("botonCartas").style.display = "block";
document.getElementById("contenedorMazo").style.display = "none"; // 👈 Oculto por defecto

const btn = document.getElementById("botonCartas");
const contenedor = document.getElementById("contenedorMazo");

if (btn && contenedor) {
  btn.onclick = () => {
    contenedor.style.display = contenedor.style.display === "none" ? "flex" : "none";
  };
}
// 1️⃣ Muestra que ya es visible
alert("✅ Ahora estás visible y se actualizará cada 5 segundos");

// 2️⃣ Cargar ovnis activos con lógica de aparición y disparo
await precargarModeloUfo();     // cargamos el modelo del último OVNI
ovniYaMostrado = false;         // para que aparezca en esta sesión
};
}
}

async function guardarSkinEnBackend(skinId) {
  try {
    const userRaw = localStorage.getItem("user");
    if (!userRaw) return;
    const userData = JSON.parse(userRaw);

    await fetch(`/api/users/${userData._id}/skin`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skinId })
    });

    console.log("✅ Skin guardada también en el backend");
  } catch (e) {
    console.error("❌ No se pudo guardar la skin en backend", e);
  }
}

// ✅ Activar visibilidad
  async function compartirUbicacion() {
  navigator.geolocation.getCurrentPosition(async (pos) => {
    const coords = {
      lat: pos.coords.latitude,
      lng: pos.coords.longitude
    };

    // ⬇️ ACTUALIZA POSICIÓN DE LA SKIN
    if (marcadorUsuario) {
      marcadorUsuario.setPosition(coords);
    }

    try {
      const res = await fetch("/api/ubicaciones/compartir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: user._id,
          lat: coords.lat,
          lng: coords.lng
        })
      });

      if (!res.ok) throw new Error("❌ No se pudo enviar ubicación");

      console.log("📡 Ubicación compartida:", coords);
    } catch (err) {
      console.error("❌ Error al compartir ubicación:", err);
    }
  });
}

let posicionActual = null;

// 🛑 Detener visibilidad y eliminar marcadores de otros usuarios
let intervaloUbicacion;
let compartiendoUbicacion = false;
let marcadoresOtros = [];

function detenerCompartirUbicacion() {
  const userRaw = localStorage.getItem("user");
  if (!userRaw) return;
  const user = JSON.parse(userRaw);
  if (!user?._id) return;

  clearInterval(intervaloUbicacion);
  intervaloUbicacion = null;

  fetch(`/api/ubicaciones/${user._id}`, { method: "DELETE" });

  marcadoresOtros.forEach(m => m.setMap(null));
  marcadoresOtros = [];

  console.log("🛑 Visibilidad desactivada y ubicación eliminada del backend");

  // ❌ Ocultar botón y contenedor con !important
  const botonCartas = document.getElementById("botonCartas");
  if (botonCartas) {
    botonCartas.style.setProperty("display", "none", "important");
  }

  const contenedorMazo = document.getElementById("contenedorMazo");
  if (contenedorMazo) {
    contenedorMazo.style.setProperty("display", "none", "important");
  }

  // 🔁 Botón de visibilidad
  const btnVisibilidad = document.getElementById("btnVisibilidad");
  if (btnVisibilidad) {
    btnVisibilidad.innerText = "Hacerme visible";
    btnVisibilidad.classList.remove("btn-visible");
    btnVisibilidad.classList.add("btn-invisible");
  }
}

async function renderMisSkinsCliente() {
  const contenedor = document.getElementById("misSkinsCliente");
  if (!contenedor) return;

  contenedor.innerHTML = "<p>Cargando tus skins...</p>";

  let misSkins = [];

  try {
    // 1) Trae el usuario con skins pobladas
    const res = await fetch(`/api/users/${user._id}`);
    const data = await res.json();

    const compradas = Array.isArray(data.skinsCompradas) ? data.skinsCompradas : [];

    if (compradas.length === 0) {
      contenedor.innerHTML = "<p>No has comprado ninguna skin todavía.</p>";
      return;
    }

    // 2) Si ya vienen pobladas, úsalo directo. Si vinieran como IDs, hacemos fallback.
    if (typeof compradas[0] === "object" && compradas[0] !== null && "_id" in compradas[0]) {
      // ✅ pobladas
      misSkins = compradas;
    } else {
      // 🔁 fallback (por si algún día no hay populate)
      const ids = new Set(compradas.map(String));
      const skinsRes = await fetch("/api/skins");
      const todas = await skinsRes.json();
      misSkins = todas.filter(s => ids.has(String(s._id)));
    }

    // 3) Render
    contenedor.innerHTML = misSkins.map(skin => `
      <div class="tarjeta-skin">
        <img src="${skin.portada}" alt="${skin.titulo}" />
        <h4>${skin.titulo}</h4>
        <p>${skin.descripcion ?? ""}</p>
      </div>
    `).join("");

  } catch (err) {
    console.error("❌ Error al cargar tus skins:", err);
    contenedor.innerHTML = "<p>❌ Error al cargar tus skins</p>";
    return;
  }

  // 4) Guarda en localStorage (evita sombrear la variable global 'user')
  const userRaw = localStorage.getItem("user");
  if (userRaw) {
    try {
      const userLS = JSON.parse(userRaw);
      userLS.skinsCompradas = misSkins; // ahora son objetos completos
      localStorage.setItem("user", JSON.stringify(userLS));
    } catch (e) {
      console.error("❌ Error al guardar skins en localStorage:", e);
    }
  }
}

document.addEventListener("DOMContentLoaded", function () {
  const tipoSelect = document.getElementById("tipoArmaSelect");
  const seccionComun = document.getElementById("comunCarta");

  const secciones = {
    Proyectil:  document.getElementById("seccionProyectil"),
    Arrastre:   document.getElementById("seccionArrastre"),
    Trampa:     document.getElementById("seccionTrampa"),
    Invocacion: document.getElementById("seccionInvocacion"),
    Vida:       document.getElementById("seccionVida"),
    Defensa:    document.getElementById("seccionDefensa")
  };

  // --- Helpers ---
  const clearInputs = (root) => {
    root.querySelectorAll("input, select, textarea").forEach(el => {
      // Los controles deshabilitados no se incluyen en FormData. Esto evita
      // enviar varios campos con el mismo nombre (dano, vida, duracion, etc.).
      el.disabled = true;
      if (el.type === "file") {
        // limpiar selección de archivos
        el.value = "";
      } else if (el.tagName === "SELECT") {
        // deja el valor por defecto del select
      } else {
        el.value = "";
      }
      // quitar required si lo tenía
      if (el.required) {
        el.dataset.wasRequired = "true";
        el.required = false;
      }
    });
  };

  const restoreRequiredIfNeeded = (root) => {
    root.querySelectorAll("input, select, textarea").forEach(el => {
      el.disabled = false;
      if (el.dataset.wasRequired === "true") {
        el.required = true;
      }
    });
  };

  // --- Mostrar/ocultar secciones y gestionar required/valores ---
  tipoSelect.addEventListener("change", () => {
    const tipo = tipoSelect.value;
    seccionComun.style.display = tipo ? "block" : "none";

    Object.keys(secciones).forEach(key => {
      const visible = key === tipo;
      const seccion = secciones[key];

      if (visible) {
        seccion.style.display = "block";
        restoreRequiredIfNeeded(seccion);
      } else {
        seccion.style.display = "none";
        clearInputs(seccion); // ← limpia valores y quita required
        // limpia previews de esa sección si los hay
        seccion.querySelectorAll('div[id^="preview"]').forEach(div => div.innerHTML = "");
        // y limpia buffers de archivos por campo (ver abajo)
        const camposDeEsta = seccion.querySelectorAll('input[type="file"][id]');
        camposDeEsta.forEach(inp => {
          const map = camposMultiples.find(c => c.id === inp.id);
          if (map && archivosPorCampo[map.name]) archivosPorCampo[map.name] = [];
        });
      }
    });
  });

  tipoSelect.dispatchEvent(new Event("change"));

  // =================== Gestión de múltiples imágenes ===================
  // Mapeo id ↔ name ↔ previewId (name = lo que espera multer)
  const camposMultiples = [
    { id: "imagenesArma",        name: "imagenesArma",        previewId: "previewImagenesArma" },
    { id: "imagenesExplosion",   name: "imagenesExplosion",   previewId: "previewImagenesExplosion" },
    { id: "imagenesMovimiento",  name: "imagenesMovimiento",  previewId: "previewImagenesMovimiento" },
    // id en HTML = imagenesBala, pero el backend espera name=imagenesDisparo
    { id: "imagenesBala",        name: "imagenesDisparo",     previewId: "previewImagenesBala" },
    { id: "imagenesMuerte",      name: "imagenesMuerte",      previewId: "previewImagenesMuerte" },
    { id: "imagenesActivacion",  name: "imagenesActivacion",  previewId: "previewImagenesActivacion" },
    { id: "imagenesExplosionTrampa", name: "imagenesExplosionTrampa", previewId: "previewImagenesExplosionTrampa" },
    { id: "imagenesInvocacion",  name: "imagenesInvocacion",  previewId: "previewImagenesInvocacion" },
    { id: "imagenesAvion",       name: "imagenesAvion",       previewId: "previewImagenesAvion" },
    { id: "imagenesBomba",       name: "imagenesBomba",       previewId: "previewImagenesBomba" },
    { id: "imagenesExplosionInvocacion", name: "imagenesExplosionInvocacion", previewId: "previewImagenesExplosionInvocacion" },
    { id: "imagenesVida",        name: "imagenesVida",        previewId: "previewImagenesVida" },
    { id: "imagenesDefensa",     name: "imagenesDefensa",     previewId: "previewImagenesDefensa" },
  ];

  const archivosPorCampo = {}; // clave = name que espera multer
  camposMultiples.forEach(c => { archivosPorCampo[c.name] = []; });

  // Listeners de cada input file múltiple
  camposMultiples.forEach(c => {
    const input   = document.getElementById(c.id);
    const preview = document.getElementById(c.previewId);
    if (!input || !preview) return;

    input.addEventListener("change", () => {
      const nuevos = Array.from(input.files);
      for (const file of nuevos) {
        if (archivosPorCampo[c.name].length >= 4) {
          alert("Máximo 4 imágenes para " + c.name);
          break;
        }
        const ya = archivosPorCampo[c.name].some(f => f.name === file.name && f.size === file.size);
        if (!ya) archivosPorCampo[c.name].push(file);
      }
      renderPreview(c.name, preview);
      input.value = ""; // evita duplicados
    });
  });

  function renderPreview(nombreCampo, contenedor) {
    contenedor.innerHTML = "";
    archivosPorCampo[nombreCampo].forEach((file, index) => {
      const row = document.createElement("div");
      row.style.display = "flex";
      row.style.alignItems = "center";
      row.style.gap = "8px";
      row.style.marginBottom = "4px";

      const name = document.createElement("span");
      name.textContent = "📄 " + file.name;

      const btn = document.createElement("button");
      btn.textContent = "❌";
      btn.type = "button";
      btn.onclick = () => {
        archivosPorCampo[nombreCampo].splice(index, 1);
        renderPreview(nombreCampo, contenedor);
      };

      row.appendChild(name);
      row.appendChild(btn);
      contenedor.appendChild(row);
    });
  }

  // =================== Envío del formulario ===================
  const form = document.getElementById("formCarta");

  function limpiarFormularioCarta() {
    cartaEditandoId = null;
    form.reset();
    Object.keys(archivosPorCampo).forEach((campo) => {
      archivosPorCampo[campo] = [];
    });
    form.querySelectorAll('div[id^="preview"]').forEach((div) => {
      div.innerHTML = "";
    });
    form.querySelector('[name="imagenPortada"]').required = true;
    tipoSelect.value = "";
    tipoSelect.dispatchEvent(new Event("change"));

    const submit = document.getElementById("submitCarta");
    const cancelar = document.getElementById("cancelarEdicionCarta");
    const estado = document.getElementById("estadoEdicionCarta");
    if (submit) submit.textContent = "Crear Carta";
    if (cancelar) cancelar.style.display = "none";
    if (estado) {
      estado.textContent = "";
      estado.style.display = "none";
    }
  }

  document
    .getElementById("cancelarEdicionCarta")
    ?.addEventListener("click", limpiarFormularioCarta);

  window.prepararFormularioCartaEdicion = (carta) => {
    limpiarFormularioCarta();
    cartaEditandoId = carta._id;

    tipoSelect.value = carta.tipoArma || "";
    tipoSelect.dispatchEvent(new Event("change"));

    const valores = {
      titulo: carta.titulo,
      descripcion: carta.descripcion,
      dispositivo: carta.dispositivo || "Ambos",
      tiempoEspera: carta.tiempoEspera ?? 0,
      sePuedeSaltar: String(Boolean(carta.sePuedeSaltar)),
      alcance: carta.alcance ?? 0,
      dano: carta.dano ?? 0,
      vida: carta.vida ?? carta.vidaQueDa ?? 0,
      cadenciaDisparo: carta.cadenciaDisparo ?? 10,
      premioBajaTorreta: carta.premioBajaTorreta ?? 100,
      duracion: Number(carta.duracion || 0) / 60,
      radioActivacion: carta.radioActivacion ?? 1,
      radioExplosion: carta.radioExplosion ?? 1,
      tiempoHastaAtaque: carta.tiempoHastaAtaque ?? 0,
      usoUnico: String(carta.usoUnico !== false),
      duracionDefensa: carta.duracionDefensa ?? 5
    };

    Object.entries(valores).forEach(([campo, valor]) => {
      form.querySelectorAll(`[name="${campo}"]`).forEach((input) => {
        input.value = valor ?? "";
      });
    });

    form.querySelector('[name="imagenPortada"]').required = false;

    const submit = document.getElementById("submitCarta");
    const cancelar = document.getElementById("cancelarEdicionCarta");
    const estado = document.getElementById("estadoEdicionCarta");
    if (submit) submit.textContent = "Guardar cambios";
    if (cancelar) cancelar.style.display = "inline-block";
    if (estado) {
      estado.textContent =
        `Editando “${carta.titulo}”. Los archivos actuales se conservarán si no eliges otros nuevos.`;
      estado.style.display = "block";
    }

    form.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  form.addEventListener("submit", async function (e) {
    e.preventDefault();
    const esEdicion = Boolean(cartaEditandoId);

    // 1) Normalizar todos los number vacíos -> "0" (evita NaN en backend)
    form.querySelectorAll('input[type="number"]:not(:disabled)').forEach(inp => {
      if (inp.value === "" || isNaN(Number(inp.value))) {
        inp.value = "0";
      }
    });

    // 2) Construir el FormData
    const formData = new FormData(form);

    // 3) Añadir los archivos múltiples desde archivosPorCampo con el NOMBRE correcto
    for (const nombreCampo in archivosPorCampo) {
      archivosPorCampo[nombreCampo].forEach(file => {
        formData.append(nombreCampo, file);
      });
    }

    try {
      const res = await fetch(esEdicion ? `/api/cards/${cartaEditandoId}` : "/api/cards", {
        method: esEdicion ? "PUT" : "POST",
        body: formData
      });
      const rawText = await res.text(); // leer siempre el cuerpo
      if (!res.ok) {
        console.error("❌ Respuesta del servidor:", rawText);
        let mensaje = rawText;
        try {
          mensaje = JSON.parse(rawText).error || rawText;
        } catch (_) {}
        throw new Error(mensaje || "Error al guardar la carta");
      }

      alert(esEdicion
        ? "✅ Carta actualizada correctamente."
        : "✅ Carta creada correctamente.");
      limpiarFormularioCarta();
      await cargarCartas();
    } catch (err) {
      console.error("❌ Error al guardar la carta:", err);
      alert(`❌ ${err.message || "Error al guardar la carta"}`);
    }
  });
});

function dispararProyectil(origenLatLng, destinoLatLng, imagenUrl, carta) {
  const velocidad = 50; // m/s
  const intervalo = 50; // ms
  const proyectil = { hit: false, explotado: false }; // anti doble hit + explosión

  if (!imagenUrl || typeof imagenUrl !== "string") {
    imagenUrl = "/img/arrow.png";
  }

  const iconoProyectil = {
    url: imagenUrl,
    scaledSize: new google.maps.Size(40, 40),
    anchor: new google.maps.Point(20, 20),
  };

  const origenLat = typeof origenLatLng.lat === "function" ? origenLatLng.lat() : origenLatLng.lat;
  const origenLng = typeof origenLatLng.lng === "function" ? origenLatLng.lng() : origenLatLng.lng;
  const destinoLat = typeof destinoLatLng.lat === "function" ? destinoLatLng.lat() : destinoLatLng.lat;
  const destinoLng = typeof destinoLatLng.lng === "function" ? destinoLatLng.lng() : destinoLatLng.lng;

  const distanciaMetros = google.maps.geometry.spherical.computeDistanceBetween(
    new google.maps.LatLng(origenLat, origenLng),
    new google.maps.LatLng(destinoLat, destinoLng)
  );

  const pasosTotales = Math.max(1, Math.floor((distanciaMetros / velocidad) * 1000 / intervalo));
  let paso = 0;

  const deltaLat = destinoLat - origenLat;
  const deltaLng = destinoLng - origenLng;

  const marcador = new google.maps.Marker({
    position: { lat: origenLat, lng: origenLng },
    map: mapaUsuario,
    icon: iconoProyectil,
  });

  const intervalId = setInterval(() => {
    if (paso >= pasosTotales) {
      clearInterval(intervalId);
      marcador.setMap(null);

      // 💥 Solo explota si NO explotó antes (por impacto)
      if (!proyectil.explotado && Array.isArray(carta?.imagenesExplosion) && carta.imagenesExplosion.length > 0) {
        const imagenExplosion = carta.imagenesExplosion[0];
        const explosion = new google.maps.OverlayView();

        explosion.onAdd = function () {
          const div = document.createElement("div");
          div.style.position = "absolute";
          div.style.width = "60px";
          div.style.height = "60px";
          div.style.backgroundImage = `url('${imagenExplosion}')`;
          div.style.backgroundSize = "contain";
          div.style.backgroundRepeat = "no-repeat";
          div.style.zIndex = "999";
          explosion.div = div;
          this.getPanes().overlayImage.appendChild(div);
        };

        explosion.draw = function () {
          const pos = this.getProjection().fromLatLngToDivPixel(destinoLatLng);
          if (this.div) {
            this.div.style.left = pos.x - 30 + "px";
            this.div.style.top = pos.y - 30 + "px";
          }
        };

        explosion.onRemove = function () {
          if (this.div && this.div.parentNode) {
          this.div.parentNode.removeChild(this.div);
          this.div = null;
          }
        };

        explosion.setMap(mapaUsuario);
        setTimeout(() => explosion.setMap(null), 1000);
      }

      return;
    }

    const lat = origenLat + (deltaLat * paso) / pasosTotales;
    const lng = origenLng + (deltaLng * paso) / pasosTotales;
    marcador.setPosition({ lat, lng });

    // 🛸 COLISIÓN CON OVNI
    if (!proyectil.hit && marcadorOvni && marcadorOvni.getPosition) {
      const distancia = google.maps.geometry.spherical.computeDistanceBetween(
        marcador.getPosition(),
        marcadorOvni.getPosition()
      );

      if (distancia <= 20) {
        console.log("☄️ Impacto con OVNI detectado");
        proyectil.hit = true;
        proyectil.explotado = true; // <- marca que ya hubo explosión
        clearInterval(intervalId);
        marcador.setMap(null);

        // 💥 Explosión en punto de impacto (única)
        if (Array.isArray(carta?.imagenesExplosion) && carta.imagenesExplosion.length > 0) {
          const imagenExplosion = carta.imagenesExplosion[0];
          const explosion = new google.maps.OverlayView();
          explosion.onAdd = function () {
            const div = document.createElement("div");
            div.style.position = "absolute";
            div.style.width = "60px";
            div.style.height = "60px";
            div.style.backgroundImage = `url('${imagenExplosion}')`;
            div.style.backgroundSize = "contain";
            div.style.backgroundRepeat = "no-repeat";
            div.style.zIndex = "999";
            explosion.div = div;
            this.getPanes().overlayImage.appendChild(div);
          };
          explosion.draw = function () {
            const pos = this.getProjection().fromLatLngToDivPixel(marcador.getPosition());
            if (this.div) {
              this.div.style.left = pos.x - 30 + "px";
              this.div.style.top = pos.y - 30 + "px";
            }
          };
          explosion.onRemove = function () {
            if (this.div && this.div.parentNode) {
              this.div.parentNode.removeChild(this.div);
              this.div = null;
            }
          };
          explosion.setMap(mapaUsuario);
          setTimeout(() => explosion.setMap(null), 1000);
        }

        const ovniId = ufoModelo?._id;
        if (!ovniId) {
          console.warn("⚠️ No se encontró el ID del OVNI (ufoModelo)");
          return;
        }

        fetch(`/api/ufo/${ovniId}/hurt`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ damage: Number(carta.dano || 0) })
        })
          .then(res => res.json())
          .then(data => {
            console.log("🧨 Daño al OVNI:", data.vida);

            if (data.muerto) {
              console.log("💥 OVNI destruido. Premio:", data.stepcoinsPremio);

              const ovniPos = marcadorOvni?.getPosition?.();
              if (marcadorOvni) {
                marcadorOvni.setMap(null);
                marcadorOvni = null;
              }

              if (intervaloMovimientoOvni) {
              clearInterval(intervaloMovimientoOvni);
              intervaloMovimientoOvni = null;
              }

              // ❌ NO mostramos otra explosión aquí (ya explotó en el impacto)

              // 🪙 Mostrar "+stepcoins" visual
              if (ovniPos) {
                const overlayTexto = new google.maps.OverlayView();
                overlayTexto.onAdd = function () {
                  const div = document.createElement("div");
                  div.style.position = "absolute";
                  div.style.color = "lime";
                  div.style.fontWeight = "bold";
                  div.style.fontSize = "20px";
                  div.style.background = "rgba(0,0,0,0.6)";
                  div.style.padding = "4px 10px";
                  div.style.borderRadius = "8px";
                  div.innerText = `+${data.stepcoinsPremio || 0}`;
                  overlayTexto.div = div;
                  this.getPanes().overlayMouseTarget.appendChild(div);
                };
                overlayTexto.draw = function () {
                  const pos = this.getProjection().fromLatLngToDivPixel(ovniPos);
                  if (this.div) {
                    this.div.style.left = `${pos.x}px`;
                    this.div.style.top = `${pos.y - 40}px`;
                  }
                };
                overlayTexto.onRemove = function () {
                  if (this.div && this.div.parentNode) {
                    this.div.parentNode.removeChild(this.div);
                    this.div = null;
                  }
                };
                overlayTexto.setMap(mapaUsuario);
                setTimeout(() => overlayTexto.setMap(null), 1000);
              }

              // 💰 Sumar premio al jugador
              const user = JSON.parse(localStorage.getItem("user") || "{}");
              user.stepcoins = (user.stepcoins || 0) + (data.stepcoinsPremio || 0);
              localStorage.setItem("user", JSON.stringify(user));

              const marcadorTexto = document.querySelector(".stepcoins");
              if (marcadorTexto) marcadorTexto.innerText = `🪙 Stepcoins: ${user.stepcoins}`;
            }
          })
          .catch(err => console.error("❌ Error al dañar OVNI:", err));

        return;
      }
    }

    paso++;
  }, intervalo);
}

let flechaElemento = null;
let apuntando = false;

// Función para iniciar el apuntado
function iniciarApuntado() {
  if (apuntando) return;
  apuntando = true;

  // Desactivar el movimiento del mapa
  mapaUsuario.setOptions({ draggable: false });

  // Crear la flecha en el centro de la pantalla
  flechaElemento = document.createElement("img");
  flechaElemento.src = "/img/arrow.png";
  flechaElemento.style.position = "absolute";
  flechaElemento.style.width = "60px";
  flechaElemento.style.height = "60px";
  // Convertir lat/lng del jugador a posición de píxeles en el contenedor del mapa
const projection = mapaUsuario.getProjection?.();
if (!projection) {
  console.warn("⚠️ No se pudo obtener la proyección del mapa.");
  return;
}

const bounds = mapaUsuario.getBounds();
const topRight = mapaUsuario.getProjection().fromLatLngToPoint(bounds.getNorthEast());
const bottomLeft = mapaUsuario.getProjection().fromLatLngToPoint(bounds.getSouthWest());
const scale = Math.pow(2, mapaUsuario.getZoom());

const point = mapaUsuario.getProjection().fromLatLngToPoint(mapaUsuario.getCenter());
const left = (point.x - bottomLeft.x) * scale;
const top = (point.y - topRight.y) * scale;

flechaElemento.style.left = `${left+310}px`;
flechaElemento.style.top = `${top+50}px`;

  flechaElemento.style.transform = "translate(-50%, -50%) rotate(0deg)";
  flechaElemento.style.pointerEvents = "none";
  flechaElemento.style.zIndex = 1;
  document.body.appendChild(flechaElemento);

  // Escuchar movimiento del mouse
  document.addEventListener("mousemove", actualizarAnguloFlecha);
  document.addEventListener("mouseup", finalizarApuntado);
}

// Función para actualizar el ángulo de la flecha
function actualizarAnguloFlecha(e) {
  const centroX = window.innerWidth / 2;
  const centroY = window.innerHeight / 2;
  const dx = e.clientX - centroX;
  const dy = e.clientY - centroY;
  const anguloRad = Math.atan2(dy, dx);
  const anguloDeg = anguloRad * (180 / Math.PI); // igual que Flutter
  if (flechaElemento) {
    flechaElemento.style.transform = `translate(-50%, -50%) rotate(${anguloDeg-90}deg)`;
  }
}

// Función para finalizar y disparar
function finalizarApuntado(e) {
  apuntando = false;

  document.removeEventListener("mousemove", actualizarAnguloFlecha);
  document.removeEventListener("mouseup", finalizarApuntado);
  if (flechaElemento) {
    document.body.removeChild(flechaElemento);
    flechaElemento = null;
  }

  mapaUsuario.setOptions({ draggable: true });

  const origen = marcadorUsuario.getPosition();
  const centroX = window.innerWidth / 2;
  const centroY = window.innerHeight / 2;
  const mouseX = e.clientX;
  const mouseY = e.clientY;

  // 1. Calcular vector desde centro hacia mouse (como en Flutter)
  const dx = mouseX - centroX;
  const dy = mouseY - centroY;

  // 2. Obtener ángulo de arrastre (tirachinas = dirección opuesta)
  const angulo = Math.atan2(dy, dx); // hacia donde apunta el mouse
  const anguloInverso = angulo + Math.PI; // dirección opuesta (tirachinas)

  // 3. Calcular destino final a X metros desde la posición del jugador
// ✅ Usa el alcance de la carta seleccionada
const distancia = typeof cartaSeleccionada?.alcance === "number" ? cartaSeleccionada.alcance : 100;
console.log("📏 Usando alcance:", distancia, "metros");

const destino = google.maps.geometry.spherical.computeOffset(
  origen,
  distancia,
  anguloInverso * (180 / Math.PI) // en grados
);

  const imagenProyectil = obtenerImagenArma(cartaSeleccionada);
  dispararProyectil(origen, destino, imagenProyectil, cartaSeleccionada);
}

function obtenerImagenArma(carta) {
  if (!carta || !Array.isArray(carta.imagenesArma) || carta.imagenesArma.length === 0) {
    return "/img/arrow.png";
  }

  let img = carta.imagenesArma[0];

  if (typeof img === "object" && img.url) {
    img = img.url;
  }

  // No añadir / si ya es URL completa
  if (typeof img === "string" && !img.startsWith("http")) {
    img = "/" + img.replace(/^\/+/, ""); // evita doble slash
  }

  return img || "/img/arrow.png";
}

//OVNIIIIIIIIIIIIIII

function obtenerPosicionAleatoriaCerca(posicionCentral) {
  const RANGO_METROS = 50;
  const deltaLat = (Math.random() - 0.5) * RANGO_METROS / 111139; // 1 grado ≈ 111139m
  const deltaLng = (Math.random() - 0.5) * RANGO_METROS / (111139 * Math.cos(posicionCentral.lat() * Math.PI / 180));
  return {
    lat: posicionCentral.lat() + deltaLat,
    lng: posicionCentral.lng() + deltaLng
  };
}

// ✅ Llamar a esto cuando el jugador dispare por primera vez
function intentarMostrarOvni() {
  if (ovniYaMostrado || !miPosicion) return;
  if (!ovnisActivos.length) return;

  const ovni = ovnisActivos[0]; // solo el primero
  const segundos = parseInt(ovni.tiempoAparicion || 0);

  console.log(`⏳ OVNI aparecerá en ${segundos}s...`);
  setTimeout(() => {
    mostrarOvni(ovni, miPosicion);
    ovniYaMostrado = true;
  }, segundos * 1000);
}

// ✅ Muestra el ovni en el mapa cerca del jugador
function mostrarOvni(ufo, usuario) {
  if (!ufo || !usuario) {
    console.warn("⚠️ Datos insuficientes para mostrar el OVNI:", ufo, usuario);
    return;
  }

  // Posición aleatoria cercana al usuario
  const latUsuario = parseFloat(usuario.lat);
  const lngUsuario = parseFloat(usuario.lng);
  const randomOffset = () => (Math.random() - 0.5) * (200 / 111000); // ~200m

  const posicion = {
    lat: latUsuario + randomOffset(),
    lng: lngUsuario + randomOffset()
  };

  console.log("🛸 OVNI mostrado en:", posicion);

  new google.maps.Marker({
    position: posicion,
    map: mapaUsuario,
    icon: {
      url: ufo.imagenOvni,
      scaledSize: new google.maps.Size(80, 80)
    }
  });
}

// Carga el último OVNI creado por el admin
async function precargarModeloUfo() {
  try {
    const res = await fetch('/api/ufo');
    const ufos = await res.json();
    ufoModelo = ufos[ufos.length - 1] || null;

    if (!ufoModelo?._id) return;

    // 👇 Obtener vida real desde backend
    const resVida = await fetch(`/api/ufo/${ufoModelo._id}/vida`);
    if (resVida.ok) {
      const data = await resVida.json();
      ufoModelo.vida = data.vida;
    }

    console.log('🛸 Modelo OVNI precargado:', ufoModelo);
  } catch (e) {
    console.error('❌ No pude cargar el modelo de OVNI', e);
  }
}

// Lánzalo cuando el usuario DISPARA por primera vez
function arrancarTemporizadorOvniSiHaceFalta() {
  if (ovniYaMostrado || !ufoModelo || !miPosicion) return;

  ovniYaMostrado = true;
  const ms = (ufoModelo.tiempoAparicion || 0) * 1000;
  console.log(`⏱️ OVNI aparecerá en ${ms / 1000}s`);

  ovniTimeout = setTimeout(() => {
    spawnOvniCercaDelJugador(ufoModelo, miPosicion);
  }, ms);
}

let intervaloMovimientoOvni = null;

function iniciarMovimientoOvni() {
  if (!marcadorOvni || !ufoModelo?.velocidadMovimiento) return;

  const velocidad = ufoModelo.velocidadMovimiento; // m/s
  const intervaloMs = 1000; // mueve un poco cada 1s

  // Limpia si ya existía
  if (intervaloMovimientoOvni) {
    clearInterval(intervaloMovimientoOvni);
    intervaloMovimientoOvni = null;
  }

  intervaloMovimientoOvni = setInterval(() => {
    if (!marcadorOvni) return;
    const posicionActual = marcadorOvni.getPosition();
    const heading = Math.random() * 360; // dirección aleatoria
    const nuevaPos = google.maps.geometry.spherical.computeOffset(posicionActual, velocidad, heading);
    marcadorOvni.setPosition(nuevaPos);
  }, intervaloMs);
}

// Pinta el OVNI (solo el marker) cerca del jugador
function spawnOvniCercaDelJugador(ufo, jugadorPos) {
  if (!ufo || !jugadorPos) return;

  const latUsuario = parseFloat(jugadorPos.lat);
  const lngUsuario = parseFloat(jugadorPos.lng);
  const randomOffset = () => (Math.random() - 0.5) * (500 / 111000); // 500 m

  const posicion = {
    lat: latUsuario + randomOffset(),
    lng: lngUsuario + randomOffset(),
  };

  // Crear marcador del OVNI
  marcadorOvni = new google.maps.Marker({
    position: posicion,
    map: mapaUsuario,
    icon: {
      url: ufo.imagenOvni || "/img/ufo_default.png",
      scaledSize: new google.maps.Size(80, 80),
    },
  });

  iniciarMovimientoOvni();

  console.log('🛸 OVNI aparecido en:', posicion);

  // Lanzar disparos cada X segundos
  const msDisparo = (ufo.segundosEntreDisparos || 3) * 1000;
  intervaloDisparosOvni = setInterval(() => {
    dispararBalaDesdeOvni(ufo, marcadorOvni.getPosition(), jugadorPos);
  }, msDisparo);

  // Desaparecer OVNI tras duración en pantalla
  const msDuracion = (ufo.duracionPantalla || 10) * 1000;
  setTimeout(() => {
    if (marcadorOvni) {
      marcadorOvni.setMap(null);
      marcadorOvni = null;
    }
    clearInterval(intervaloDisparosOvni);
    console.log("🕛 OVNI desaparecido");
  }, msDuracion);
}

function dispararBalaDesdeOvni(ufo, origenLatLng, destinoLatLng) {
  if (!origenLatLng || !destinoLatLng) return;

  const damage = Number(ufo.danoBala || 50);
  const velocidad = ufo.velocidadBala || 100; // m/s
  const intervalo = 50; // ms

  const iconoBala = {
    url: ufo.imagenBala || "/img/bala_default.png",
    scaledSize: new google.maps.Size(30, 30),
    anchor: new google.maps.Point(15, 15),
  };

  const deltaLat = destinoLatLng.lat - origenLatLng.lat();
  const deltaLng = destinoLatLng.lng - origenLatLng.lng();
  const distancia = Math.sqrt(deltaLat ** 2 + deltaLng ** 2);
  const pasosTotales = Math.floor((distancia * 111139) / velocidad / (intervalo / 1000));

  let paso = 0;

  const bala = new google.maps.Marker({
    position: origenLatLng,
    map: mapaUsuario,
    icon: iconoBala,
  });

  const mover = setInterval(() => {
    if (paso >= pasosTotales) {
      clearInterval(mover);
      bala.setMap(null);
      return;
    }

    const lat = origenLatLng.lat() + (deltaLat * paso / pasosTotales);
    const lng = origenLatLng.lng() + (deltaLng * paso / pasosTotales);
    bala.setPosition({ lat, lng });

    // ⚠️ Protegido: solo si userData existe y tiene _id
    if (userData && userData._id) {
      const impacto = detectarImpactoBalaOvni(bala, damage, userData._id);
      if (impacto) {
        clearInterval(mover);
        return;
      }
    }

    paso++;
  }, intervalo);
}

function detectarImpactoBalaOvni(marcadorBala, damage, userId) {
  const posJugador = marcadorUsuario?.getPosition?.();
  if (!posJugador) return false;

  const posBala = marcadorBala.getPosition();
  const distancia = google.maps.geometry.spherical.computeDistanceBetween(posJugador, posBala);

  if (distancia >= 20) return false;

  console.log("☠️ ¡Impacto recibido!");

  if (estaMuerto) {
    marcadorBala.setMap(null);
    return true;
  }

  const user = JSON.parse(localStorage.getItem("user") || "{}");
  const skinActiva = user?.skinSeleccionada;
  const skinMuriendoUrl = skinActiva?.scripts?.muriendo?.[0];
  const skinParadoUrl = skinActiva?.scripts?.parado?.[0] || "/img/fallback.png";

  skinParadoActualUrl = skinParadoUrl;

  fetch(`/api/life/${userId}/hurt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ damage }),
  })
    .then(res => res.json())
    .then(data => {
      const vida = data.vida;
      console.log("💔 Nueva vida:", vida);
      actualizarBarraVida(vida);

      if (typeof data.stepcoins === "number") {
        // ✅ Actualizar el objeto user
        user.stepcoins = data.stepcoins;
        localStorage.setItem("user", JSON.stringify(user));

        // ✅ Actualizar contador si estás en "Inicio"
        const seccionVisible = document.querySelector(".seccion:not([style*='display: none'])");
        if (seccionVisible?.id === "inicio") {
          const marcador = document.querySelector(".stepcoins");
          if (marcador) {
            marcador.innerText = `🪙 Stepcoins: ${data.stepcoins}`;
          }
        }
      }

      if (vida <= 0) {
        estaMuerto = true;

        if (skinMuriendoUrl) {
          console.log("💀 Mostrando skin muriendo...");
          marcadorUsuario.setIcon({
            url: skinMuriendoUrl,
            scaledSize: new google.maps.Size(48, 48),
          });
        }

        if (reviveTimeoutId) clearTimeout(reviveTimeoutId);

        reviveTimeoutId = setTimeout(async () => {
          try {
            const res = await fetch(`/api/life/${userId}/resurrect`, { method: "POST" });
            if (res.ok) {
              const resultado = await res.json();
              console.log("🧬 Revivido:", resultado);

              marcadorUsuario.setIcon(null);
              setTimeout(() => {
                marcadorUsuario.setIcon({
                  url: skinParadoActualUrl,
                  scaledSize: new google.maps.Size(48, 48),
                });
              }, 50);

              actualizarBarraVida(1000);
              estaMuerto = false;
              reviveTimeoutId = null;
            }
          } catch (err) {
            console.error("❌ Error al revivir:", err);
          }
        }, 2000);
      }
    })
    .catch(err => console.error("❌ Error en detectarImpactoBalaOvni:", err));

  marcadorBala.setMap(null);
  return true;
}

function actualizarBarraVida(nuevaVida) {
  const porcentaje = Math.max(0, Math.min(100, (nuevaVida / 1000) * 100));
  document.querySelector(".vida-inner").style.width = `${porcentaje}%`;
}

//CANDADOSSSSSSS

// --- Constantes BLE que usaremos luego (dejadas aquí arriba para no olvidarlas)
// 🔧 Añadimos candidatos porque algunos firmwares usan 0xFFF0/0xFFE0 en vez del 6e4000...
const BLE = {
  SERVICE_NUS: "6e400001-b5a3-f393-e0a9-e50e24dcca9e",  // Nordic UART (el del PDF)
  WRITE_NUS:   "6e400002-b5a3-f393-e0a9-e50e24dcca9e",
  NOTIFY_NUS:  "6e400003-b5a3-f393-e0a9-e50e24dcca9e",

  // 🔧 Servicios custom típicos en hardware chino
  SERVICE_FFF0: "0000fff0-0000-1000-8000-00805f9b34fb",
  SERVICE_FFE0: "0000ffe0-0000-1000-8000-00805f9b34fb",

  // 🔐 Clave semilla para generar KeyMap (según protocolo OMNI)
  KEY_ORG: [
    0x61, 0x66, 0x6B, 0x33,
    0x74, 0x79, 0x73, 0x77,
    0x34, 0x70, 0x73, 0x6B,
    0x32, 0x36, 0x68, 0x6A
  ],
};

// Servicios opcionales que solicitamos al hacer pairing BLE
const OPTIONAL_SERVICES = [
  BLE.SERVICE_NUS,
  BLE.SERVICE_FFF0,
  BLE.SERVICE_FFE0,
  0x180A, // device_information
  0x180F, // battery
];

// Estado global del sistema de candados
let candadosState = {
  device: null,
  server: null,
  service: null,
  writeChar: null,
  notifyChar: null,
  keyMap: null,
  heartbeatTimer: null,
  usarKeyMap: false,  // 🔑 se actualiza dinámicamente según respuesta del candado
};

function renderCandados() {
  const root = document.getElementById("candados");
  root.innerHTML = `
    <section id="candados">
      <h2>🔐 Candados</h2>

      <div class="card">
        <h3>Conexión</h3>
        <label>Contraseña (4 dígitos hex / dec):</label>
        <input id="candado-password" type="text" placeholder="1234" />
        <button id="btn-candado-scan">Escanear & Conectar (BLE)</button>
        <button id="btn-candado-desconectar" disabled>Desconectar</button>
        <p id="candado-status">Estado: desconectado</p>
      </div>

      <div class="card">
        <h3>Control</h3>
        <button id="btn-candado-abrir" disabled>🔓 Abrir candado</button>
        <button id="btn-candado-cerrar" disabled>🔒 Cerrar candado</button>
      </div>

      <div class="card">
        <h3>Logs</h3>
        <pre id="candado-log" style="max-height:200px;overflow:auto;background:#111;color:#0f0;padding:8px"></pre>
      </div>

      <small>
        Nota: Esta pestaña usa Web Bluetooth (Chrome/Edge/Opera + HTTPS o localhost).
        El backend NO puede abrir el candado directamente (BLE es local), pero
        aquí guardaremos en backend los eventos (quién/ cuándo abrió).
      </small>
    </section>
  `;

  // Listeners (las funciones concretas te las paso en el siguiente mensaje)
  document.getElementById("btn-candado-scan")
    .addEventListener("click", () => candados_scanYConectar());

  document.getElementById("btn-candado-desconectar")
    .addEventListener("click", () => candados_desconectar());

  document.getElementById("btn-candado-abrir")
    .addEventListener("click", () => candados_abrir());

  document.getElementById("btn-candado-cerrar")
    .addEventListener("click", () => candados_cerrar());
}

// Helpers simples de UI (los usamos luego)
function candados_log(msg) {
  const el = document.getElementById("candado-log");
  if (el) {
    el.textContent += `[${new Date().toISOString()}] ${msg}\n`;
    el.scrollTop = el.scrollHeight;
  }
}
function candados_setStatus(text) {
  const el = document.getElementById("candado-status");
  if (el) el.textContent = `Estado: ${text}`;
}
function candados_enableControls(connected) {
  const btnScan = document.getElementById("btn-candado-scan");
  const btnDisc = document.getElementById("btn-candado-desconectar");
  const btnOpen = document.getElementById("btn-candado-abrir");
  const btnClose = document.getElementById("btn-candado-cerrar");

  if (!btnScan || !btnDisc || !btnOpen || !btnClose) return;

  btnScan.disabled = connected;
  btnDisc.disabled = !connected;
  btnOpen.disabled = !connected;
  btnClose.disabled = !connected;
}

async function candados_scanYConectar() {
  try {
    candados_log("🔍 Escaneando dispositivos...");

    const device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: "OBL" }],
      optionalServices: OPTIONAL_SERVICES,
    });

    candadosState.device = device;
    candados_setStatus("conectando...");
    candados_log(`🔗 Conectando a ${device.name || device.id}...`);

    const server = await device.gatt.connect();
    candadosState.server = server;

    await new Promise(r => setTimeout(r, 2000)); // Espera para exponer servicios

    let services = [];
    try {
      services = await server.getPrimaryServices();
    } catch (e) {
      candados_log("⚠️ getPrimaryServices() lanzó error: " + e.message);
    }

    if (!services.length) {
      candados_log("⚠️ getPrimaryServices vacío. Intentando con UUIDs específicos...");

      const fallbackUUIDs = [
        BLE.SERVICE_NUS,
        BLE.SERVICE_FFF0,
        BLE.SERVICE_FFE0,
      ];

      for (const uuid of fallbackUUIDs) {
        try {
          const svc = await server.getPrimaryService(uuid);
          const chars = await svc.getCharacteristics();
          services = [svc];
          candados_log("✅ Servicio encontrado: " + uuid);
          for (const ch of chars) {
            candados_log("  ↳ Char: " + ch.uuid);
          }
          break;
        } catch (e) {
          candados_log(`❌ Servicio ${uuid} no accesible: ${e.message}`);
        }
      }
    }

    if (!services.length) throw new Error("No Services found in device");

    candados_log("📦 Servicios disponibles:");
    for (const svc of services) candados_log(" - " + svc.uuid);

    let service = null;
    let writeChar = null;
    let notifyChar = null;

    for (const svc of services) {
      const chars = await svc.getCharacteristics();
      for (const ch of chars) {
        const uuid = ch.uuid.toLowerCase();
        if (uuid.includes("6e400002") || ch.properties.writeWithoutResponse) {
          writeChar = ch; service = svc;
        }
        if (uuid.includes("6e400003") || ch.properties.notify) {
          notifyChar = ch; service = svc;
        }
      }
    }

    if (!writeChar || !notifyChar) {
      candados_log("❌ No encontré write/notify. Intento heurístico...");
      for (const svc of services) {
        const chars = await svc.getCharacteristics();
        if (chars.length >= 2) {
          const w = chars.find(c => c.properties.writeWithoutResponse || c.properties.write);
          const n = chars.find(c => c.properties.notify);
          if (w && n) {
            writeChar = w; notifyChar = n; service = svc;
            break;
          }
        }
      }
    }

    if (!writeChar || !notifyChar) {
      throw new Error("No pude identificar las características write/notify.");
    }

    candadosState.service = service;
    candadosState.writeChar = writeChar;
    candadosState.notifyChar = notifyChar;

    candados_log("✅ Características encontradas:");
    candados_log("   - write:  " + writeChar.uuid);
    candados_log("   - notify: " + notifyChar.uuid);

    await notifyChar.startNotifications();
    notifyChar.addEventListener("characteristicvaluechanged", (event) => {
      const value = new Uint8Array(event.target.value.buffer);
      candados_log("📨 Notif: " + [...value].map(v => v.toString(16).padStart(2, "0")).join(" "));
      if (value.length >= 5 && value[4] !== undefined) {
        const hasLocalKey = (value[4] & 0x08) !== 0;
        candadosState.usarKeyMap = hasLocalKey;
        candados_log(`🔍 LocalKey: ${hasLocalKey ? "sí" : "no"} → ${hasLocalKey ? "usamos KeyMap" : "no cifrar comandos"}`);
      }
      if (value.length >= 1) {
        const byte0 = value[0];
        const estaAbierto = (byte0 & 0x80) !== 0;
        const estaCerrado = (byte0 & 0x01) !== 0 || (byte0 & 0x02) !== 0;

        if (estaAbierto) candados_log("🔓 Estado detectado: ABIERTO");
        else if (estaCerrado) candados_log("🔒 Estado detectado: CERRADO");
        else candados_log("❔ Estado no definido con claridad");
      }
    });

    const passwordStr = document.getElementById("candado-password").value.trim() || "1234";
    const passBytes = passwordStr.split("").map(c => c.charCodeAt(0)).slice(0, 4);
    while (passBytes.length < 4) passBytes.push(0x00);

    candadosState.keyMap = generarKeyMap(passBytes, BLE.KEY_ORG);

    const verifyPacket = construirVerifyKeyPacket(passBytes);
    await writeChar.writeValueWithoutResponse(new Uint8Array(verifyPacket));
    candados_log("🔑 Enviado paquete de autenticación");

    candadosState.heartbeatTimer = setInterval(async () => {
      try {
        const rand = Math.floor(Math.random() * 256);
        const heartbeat = construirPaquete([0x07, 0x00], rand, candadosState.keyMap);
        await writeChar.writeValueWithoutResponse(new Uint8Array(heartbeat));
      } catch (e) {
        candados_log("⚠️ Heartbeat error: " + e.message);
      }
    }, 2000);

    candados_enableControls(true);
    candados_setStatus(`conectado a ${device.name || device.id}`);
    candados_log("✅ Conexión establecida");

  } catch (err) {
    candados_log("❌ Error: " + err.message);
    candados_enableControls(false);
    candados_setStatus("desconectado");
  }
}

async function candados_abrir() {
  const rand = Math.floor(Math.random() * 256);
  const paquete = construirPaquete([0x05, 0x80], rand, candadosState.keyMap);
  await candadosState.writeChar.writeValueWithoutResponse(new Uint8Array(paquete));
  candados_log("🔓 Comando enviado: abrir candado");
  try {
  const res = await fetch("/api/candados/log", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      accion: "abrir",
      candadoId: candadosState.device.id || candadosState.device.name, // Usa aquí el ID real que tengas
    }),
  });
  const data = await res.json();
  if (data.ok) candados_log("📦 Evento registrado en backend.");
  else candados_log("⚠️ Fallo al registrar en backend: " + (data.error || "error desconocido"));
} catch (e) {
  candados_log("❌ Error backend: " + e.message);
}
}

async function candados_cerrar() {
  const rand = Math.floor(Math.random() * 256);
  const paquete = construirPaquete([0x05, 0x01], rand, candadosState.keyMap);
  await candadosState.writeChar.writeValueWithoutResponse(new Uint8Array(paquete));
  candados_log("🔒 Comando enviado: cerrar candado");
}

function construirVerifyKeyPacket(passwordBytes) {
  const rand = Math.floor(Math.random() * 256);
  const cmd = 0x01;
  const datos = passwordBytes;
  const suma = (rand + cmd + datos.reduce((a, b) => a + b, 0)) & 0xff;

  return [0xAB, 0xDE, 0x07, rand, cmd, ...datos, suma];
}

function generarKeyMap(inputKey, keyOrg) {
  const keyMap = new Array(256);
  let index = 0;
  for (let k = 0; k < 4; k++) {
    for (let i = 0; i < inputKey.length; i++) {
      for (let j = 0; j < keyOrg.length; j++) {
        keyMap[index++] = ((inputKey[i] + 0x30 + k) ^ keyOrg[j]) & 0xff;
      }
    }
  }
  return keyMap;
}

function construirPaquete([cmd, ...dataBytes], rand, keyMap) {
  const usarKeyMap = candadosState.usarKeyMap;
  const encryptedData = dataBytes.map((b, i) => {
    if (usarKeyMap) {
      const index = (rand + i) % 256;
      return b ^ keyMap[index];
    }
    return b;
  });

  const len = 4 + encryptedData.length;
  const suma = (rand + cmd + encryptedData.reduce((a, b) => a + b, 0)) & 0xff;

  return [0xAB, 0xDE, len, rand, cmd, ...encryptedData, suma];
}

async function candados_desconectar() {
  try {
    if (candadosState.heartbeatTimer) {
      clearInterval(candadosState.heartbeatTimer);
      candadosState.heartbeatTimer = null;
    }
    if (candadosState.device?.gatt.connected) {
      candadosState.device.gatt.disconnect();
    }
  } catch (err) {
    candados_log("⚠️ Error al desconectar: " + err.message);
  } finally {
    candados_enableControls(false);
    candados_setStatus("desconectado");
  }
}


//RANKINGSSS

async function renderRankings() {
  const contenedor = document.getElementById("contenedorRanking");
  contenedor.innerHTML = "<p>⏳ Cargando...</p>";

  try {
    const res = await fetch("/api/stepcoins/ranking"); // asegúrate que la ruta concuerde
    const usuarios = await res.json();

    if (!Array.isArray(usuarios)) {
      contenedor.innerHTML = "<p>⚠️ Error al cargar el ranking.</p>";
      return;
    }

    contenedor.innerHTML = `
      <table class="tablaRanking">
        <thead>
          <tr>
            <th>#</th>
            <th>Nombre</th>
            <th>🪙 Stepcoins</th>
          </tr>
        </thead>
        <tbody>
          ${usuarios.map((u, i) => `
            <tr>
              <td>${i + 1}</td>
              <td>${u.nombre}</td>
              <td>${u.stepcoins}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;
  } catch (err) {
    console.error("❌ Error cargando ranking:", err);
    contenedor.innerHTML = "<p>⚠️ No se pudo cargar el ranking.</p>";
  }
}


//RETOOOOSSSSS

function renderCrearRetos() {
  document.getElementById("crearRetos").style.display = "block";
  const form = document.getElementById("formCrearReto");
  const listaRetos = document.getElementById("listaRetos");
  form.reset();

  // SUBMIT FORMULARIO
  form.onsubmit = async (e) => {
    e.preventDefault();

    const formData = new FormData(form);

    // Convertir fechas a ISO si es necesario
    formData.set("fechaInicio", new Date(formData.get("fechaInicio")).toISOString());
    formData.set("fechaFin", new Date(formData.get("fechaFin")).toISOString());

    // Subir imagen primero
const fileInput = document.getElementById("imagenPremio");
const imagenForm = new FormData();
imagenForm.append("file", fileInput.files[0]); // 👈 CORRECTO para subir el archivo

    const subida = await fetch("/api/retos/upload", {
  method: "POST",
  body: imagenForm,
});

if (!subida.ok) {
  const errorText = await subida.text();
  console.error("Error al subir imagen:", errorText);
  return alert("❌ Error al subir imagen");
}

const subidaJson = await subida.json();

    const reto = {
      titulo: formData.get("titulo"),
      descripcion: formData.get("descripcion"),
      premio: formData.get("premio"),
      requisitosEspeciales: formData.get("requisitosEspeciales"),
      fechaInicio: formData.get("fechaInicio"),
      fechaFin: formData.get("fechaFin"),
      imagenPremioUrl: subidaJson.url,
    };

    const res = await fetch("/api/retos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reto),
    });

    if (res.ok) {
      alert("✅ Reto creado con éxito");
      renderCrearRetos(); // recarga lista
    } else {
      alert("❌ Error al crear reto");
    }
  };

  // CARGAR RETOS EXISTENTES
  fetch("/api/retos")
    .then((res) => res.json())
    .then((retos) => {
      listaRetos.innerHTML = "";
      retos.forEach((r) => {
        const div = document.createElement("div");
        div.className = "reto";
        div.innerHTML = `
          <h4>${r.titulo}</h4>
          <img src="${r.imagenPremioUrl}" alt="Premio" style="max-width: 200px;">
          <p>${r.descripcion}</p>
          <p><strong>Premio:</strong> ${r.premio}</p>
          <p><strong>Fechas:</strong> ${new Date(r.fechaInicio).toLocaleDateString()} - ${new Date(r.fechaFin).toLocaleDateString()}</p>
          <button onclick="eliminarReto('${r._id}')">🗑️ Eliminar</button>
        `;
        listaRetos.appendChild(div);
      });
    });
}

// ✅ Función para eliminar reto
async function eliminarReto(id) {
  if (!confirm("¿Seguro que quieres eliminar este reto?")) return;

  const res = await fetch(`/api/retos/${id}`, {
    method: "DELETE",
  });

  if (res.ok) {
    alert("✅ Reto eliminado");
    renderCrearRetos(); // recargar lista
  } else {
    const json = await res.json();
    alert("❌ Error al eliminar: " + (json.error || "desconocido"));
  }
}

async function renderRetosCliente() {
  const content = document.getElementById("content");
  const seccionAnterior = document.getElementById("retosCliente"); // usa un id fijo

  if (seccionAnterior) seccionAnterior.remove(); // limpia sección previa

  const nuevaSeccion = document.createElement("section");
  nuevaSeccion.id = "retosCliente";      // id fijo coherente con la sección
  nuevaSeccion.className = "seccion";    // ← CLAVE: para que renderSection la oculte
  nuevaSeccion.style.display = "block";  // la mostramos cuando se entra en Retos

  try {
    const res = await fetch("/api/retos/activos");
    if (!res.ok) {
      const t = await res.text().catch(()=> "");
      console.error("retos/activos", res.status, t);
      nuevaSeccion.innerHTML = "<p>Error al cargar retos.</p>";
    } else {
      const retos = await res.json();

      if (!Array.isArray(retos) || retos.length === 0) {
        nuevaSeccion.innerHTML = "<p>No hay retos activos actualmente.</p>";
      } else {
        retos.forEach((r) => {
          const yaInscrito = r.participantes?.some(p => p.userId === usuarioActual._id);
          const retoDiv = document.createElement("div");
          retoDiv.className = "reto-cliente";
          retoDiv.innerHTML = `
            <h3>${r.titulo}</h3>
            ${r.imagenPremioUrl ? `<img src="${r.imagenPremioUrl}" alt="Premio" style="max-width:200px;">` : ""}
            <p>${r.descripcion ?? ""}</p>
            <p><strong>Premio:</strong> ${r.premio ?? ""}</p>
            <p><strong>Fechas:</strong> ${new Date(r.fechaInicio).toLocaleDateString()} - ${new Date(r.fechaFin).toLocaleDateString()}</p>
            <button ${yaInscrito ? "disabled" : ""}>
              ${yaInscrito ? "Inscrito" : "Inscribirse"}
            </button>
          `;

          const boton = retoDiv.querySelector("button");
          if (!yaInscrito && boton) {
            boton.onclick = async () => {
              const r2 = await fetch(`/api/retos/${r._id}/inscribirse`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ userId: usuarioActual._id }),
              });
              if (r2.ok) {
                alert("✅ Te has inscrito al reto");
                boton.disabled = true;
                boton.textContent = "Inscrito";
              } else {
                const j = await r2.json().catch(()=> ({}));
                alert("❌ " + (j.error || "Error al inscribirte"));
              }
            };
          }

          nuevaSeccion.appendChild(retoDiv);
        });
      }
    }
  } catch (e) {
    console.error(e);
    nuevaSeccion.innerHTML = "<p>Error al cargar retos.</p>";
  }

  content.appendChild(nuevaSeccion);
}


//PEDIDOSSSSS SSSS


// ===============================
// Pedidos (ADMIN)
// ===============================
const _pedidosState = {
  inited: false,
  page: 1,
  pages: 1,
  limit: 20,
  q: "",
  paid: true,
  sort: "-createdAt",
  loading: false,
  ship: "", // "", "true" o "false"
};

function renderPedidosAdmin() {
  // mostrar sección
  const sec = document.getElementById("pedidosAdmin");
  if (sec) sec.style.display = "block";

  // one-time init de listeners
  if (!_pedidosState.inited) {
    // Navegación desde el menú (si existe el item)
    document.getElementById("menuPedidos")?.addEventListener("click", (e) => {
      e.preventDefault();
      mostrarSoloSeccion("pedidosAdmin");
      renderPedidosAdmin();
    });

    // Filtros
    document.getElementById("filtroPedidosQ")?.addEventListener(
      "input",
      (_maybeDebounce())(() => {
        _pedidosState.page = 1;
        _pedidosFetchAndRender();
      }, 350)
    );
    document
      .getElementById("filtroPedidosPaid")
      ?.addEventListener("change", () => {
        _pedidosState.page = 1;
        _pedidosFetchAndRender();
      });
    document
      .getElementById("filtroPedidosSort")
      ?.addEventListener("change", () => {
        _pedidosState.page = 1;
        _pedidosFetchAndRender();
      });
    document
      .getElementById("filtroPedidosLimit")
      ?.addEventListener("change", () => {
        _pedidosState.page = 1;
        _pedidosFetchAndRender();
      });

    // Paginación
    document.getElementById("pedidosPrev")?.addEventListener("click", () => {
      if (_pedidosState.page > 1) {
        _pedidosState.page -= 1;
        _pedidosFetchAndRender();
      }
    });
    document.getElementById("pedidosNext")?.addEventListener("click", () => {
      if (_pedidosState.page < _pedidosState.pages) {
        _pedidosState.page += 1;
        _pedidosFetchAndRender();
      }
    });

    // Botones acciones
    document
      .getElementById("btnRefrescarPedidos")
      ?.addEventListener("click", () => _pedidosFetchAndRender());
    document
      .getElementById("btnExportarPedidos")
      ?.addEventListener("click", _pedidosExportCsv);

    // Filtro por envío (opcional si añadiste el <select id="filtroPedidosShip"> en HTML)
    document
      .getElementById("filtroPedidosShip")
      ?.addEventListener("change", () => {
      _pedidosState.page = 1;
      _pedidosFetchAndRender();
    });
  

    _pedidosState.inited = true;
  }

  // Cargar UI->estado y pintar
  _pedidosReadFiltersFromUI();
  _pedidosFetchAndRender();
}

// --- helpers internos ---
function _pedidosReadFiltersFromUI() {
  const qEl = document.getElementById("filtroPedidosQ");
  const paidEl = document.getElementById("filtroPedidosPaid");
  const sortEl = document.getElementById("filtroPedidosSort");
  const limitEl = document.getElementById("filtroPedidosLimit");
  const shipEl = document.getElementById("filtroPedidosShip");

  _pedidosState.q = (qEl?.value || "").trim();
  _pedidosState.paid = !!paidEl?.checked;
  _pedidosState.sort = sortEl?.value || "-createdAt";
  _pedidosState.limit = parseInt(limitEl?.value || "20", 10) || 20;
  _pedidosState.ship = (shipEl?.value ?? "").trim(); // "", "true", "false"
}

async function _pedidosFetchAndRender() {
  if (_pedidosState.loading) return;
  _pedidosState.loading = true;

  const tbody = document.querySelector("#tablaPedidos tbody");
  const pageLabel = document.getElementById("pedidosPaginaLabel");
  if (tbody) tbody.innerHTML = `<tr><td colspan="6">Cargando...</td></tr>`;

  try {
    const params = new URLSearchParams({
      page: String(_pedidosState.page),
      limit: String(_pedidosState.limit),
      sort: _pedidosState.sort,
      paid: String(_pedidosState.paid),
    });
    if (_pedidosState.q) params.set("q", _pedidosState.q);
    if (_pedidosState.ship) params.set("ship", _pedidosState.ship);

    const token = localStorage.getItem("token") || "";
    const resp = await fetch(`/api/admin/orders?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    _pedidosState.page = data.page || 1;
    _pedidosState.pages = data.pages || 1;

    if (!Array.isArray(data.items) || data.items.length === 0) {
      if (tbody) tbody.innerHTML = `<tr><td colspan="6">Sin resultados</td></tr>`;
    } else {
  if (tbody) tbody.innerHTML = data.items.map(_pedidoRowHtml).join("");

  // Bind botones "Ver"
  document.querySelectorAll(".btnVerPedidoAdmin").forEach((btn) => {
    btn.addEventListener("click", () => _pedidosOpenDetail(btn.dataset.id));
  });

  // Bind "Marcar enviado / Desmarcar"
  document.querySelectorAll(".btnShip").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      const isShipped = btn.dataset.shipped === "1";
      let trackingNumber = "";
      if (!isShipped) {
        trackingNumber = prompt("Número de seguimiento (opcional):") || "";
      }
      try {
        await _pedidosToggleShip(id, !isShipped, trackingNumber);
        _pedidosFetchAndRender();
      } catch (e) {
        console.error("Marcar envío error:", e);
        alert("No se pudo actualizar el estado de envío");
      }
    });
  });
}

    if (pageLabel) pageLabel.textContent = `${_pedidosState.page} / ${_pedidosState.pages}`;
  } catch (err) {
    console.error("PedidosAdmin error:", err);
    if (tbody) tbody.innerHTML = `<tr><td colspan="6">Error al cargar</td></tr>`;
  } finally {
    _pedidosState.loading = false;
  }
}

function _pedidoRowHtml(o) {
  const fecha = o.createdAt
    ? new Date(o.createdAt).toLocaleString("es-ES", { dateStyle: "short", timeStyle: "medium" })
    : "-";
  const pedido = o.providerOrderId || o._id;
  const cliente =
    (o.shipping && o.shipping.name) || (o.billing && o.billing.name) || "-";
  const total =
    o.total != null && o.currency
      ? `${o.total} ${o.currency}`
      : o.total ?? "-";
  const estadoPago = o.paid
    ? o.providerStatus
      ? `Pagado · ${o.providerStatus}`
      : "Pagado"
    : o.providerStatus || "Pendiente";

  const enviado = !!(o.fulfillment && o.fulfillment.shipped);
  const shippedLabel = enviado ? "ENVIADO" : "PENDIENTE ENVÍO";
  const shippedBadgeClass = enviado ? "badge--green" : "badge--yellow";
  const btnShipText = enviado ? "Desmarcar envío" : "Marcar enviado";

  const shippedAt =
    o.fulfillment && o.fulfillment.shippedAt
      ? new Date(o.fulfillment.shippedAt).toLocaleString("es-ES", {
          dateStyle: "short",
          timeStyle: "short",
        })
      : "";

  return `
    <tr class="${enviado ? "row--shipped" : ""}">
      <td>${fecha}</td>
      <td>${pedido}</td>
      <td>${cliente}</td>
      <td>${total}</td>
      <td>
        ${estadoPago}
        <div class="badge ${shippedBadgeClass}" title="${shippedAt}">
          ${shippedLabel}
        </div>
      </td>
      <td>
        <button class="btn btn-small btnShip" data-id="${o._id}" data-shipped="${
    enviado ? "1" : "0"
  }">${btnShipText}</button>
        <button class="btn btn-small btnVerPedidoAdmin" data-id="${o._id}">Ver</button>
      </td>
    </tr>
  `;
}

async function _pedidosOpenDetail(id) {
  try {
    const token = localStorage.getItem("token") || "";
    const resp = await fetch(`/api/admin/orders/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const o = await resp.json();

    const itemsHtml = (o.items || [])
      .map(
        (it) => `
      <tr>
        <td>${it.name}</td>
        <td>${it.qty}</td>
        <td>${it.unitPrice}</td>
        <td>${it.subtotal}</td>
      </tr>`
      )
      .join("");

    const html = `
      <div class="modal" id="modalPedidoAdmin" style="display:block;">
        <div class="modal-content">
          <div class="modal-header">
            <h3>Pedido ${o.providerOrderId || o._id}</h3>
            <button id="modalPedidoAdminClose" class="modal-close">&times;</button>
          </div>
          <div class="modal-body">
            <p><strong>Fecha:</strong> ${o.createdAt ? new Date(o.createdAt).toLocaleString() : "-"}</p>
            <p><strong>Estado:</strong> ${o.paid ? "Pagado" : "Pendiente"} · ${o.providerStatus || "-"}</p>
            <p><strong>Total:</strong> ${o.total} ${o.currency || ""}</p>

            <h4>Envío</h4>
            <p>${o.shipping?.name || "-"} ${o.shipping?.phone ? "· " + o.shipping.phone : ""}</p>
            <p>${[
              o.shipping?.address1,
              o.shipping?.city,
              o.shipping?.state,
              o.shipping?.zip,
              o.shipping?.country,
            ].filter(Boolean).join(", ")}</p>

            <h4>Facturación</h4>
            <p>${o.billing?.name || "-"} ${o.billing?.taxId ? "· " + o.billing.taxId : ""}</p>
            <p>${[
              o.billing?.address1,
              o.billing?.city,
              o.billing?.state,
              o.billing?.zip,
              o.billing?.country,
            ].filter(Boolean).join(", ")}</p>

            <h4>Artículos</h4>
            <table class="tabla">
              <thead><tr><th>Producto</th><th>Cant.</th><th>Precio</th><th>Subtotal</th></tr></thead>
              <tbody>${itemsHtml}</tbody>
            </table>
          </div>
        </div>
      </div>
    `;

    _showModal(html, "modalPedidoAdmin", "modalPedidoAdminClose");
  } catch (e) {
    console.error("Detalle pedido error:", e);
    alert("No se pudo cargar el detalle del pedido");
  }
}

async function _pedidosExportCsv() {
  try {
    // refrescar filtros actuales
    _pedidosReadFiltersFromUI();

    const params = new URLSearchParams({
      sort: _pedidosState.sort,
      paid: String(_pedidosState.paid),
    });
    if (_pedidosState.q) params.set("q", _pedidosState.q);
    if (_pedidosState.ship) params.set("ship", _pedidosState.ship);

    const token = localStorage.getItem("token") || "";
    const resp = await fetch(`/api/admin/orders/export.csv?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const blob = await resp.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "orders.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (e) {
    console.error("Export CSV error:", e);
    alert("Error al exportar CSV");
  }
}

// Utilidad para mostrar solo una sección (si no tienes función global)
function mostrarSoloSeccion(id) {
  document.querySelectorAll(".seccion").forEach((s) => (s.style.display = "none"));
  const el = document.getElementById(id);
  if (el) el.style.display = "block";
}

// Debounce (solo define si no existe)
function _maybeDebounce() {
  if (typeof debounce === "function") return debounce;
  return function (fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  };
}

// Modal mínimo (usa tus estilos/clases si ya tienes uno)
function _showModal(html, wrapId, closeId) {
  // eliminar modal anterior si existe
  document.getElementById(wrapId)?.remove();

  const wrap = document.createElement("div");
  wrap.id = wrapId;
  wrap.innerHTML = html;
  document.body.appendChild(wrap);

  document.getElementById(closeId)?.addEventListener("click", () => {
    wrap.remove();
  });

  // cerrar al click fuera del contenido
  wrap.addEventListener("click", (e) => {
    if (e.target.id === wrapId) wrap.remove();
  });
}

async function _pedidosToggleShip(id, shipped, trackingNumber) {
  const token = localStorage.getItem("token") || "";
  const resp = await fetch(`/api/admin/orders/${id}/ship`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ shipped, trackingNumber }),
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }
  return resp.json();
}
