/** @odoo-module **/

function findHeaderRoot() {
    // Buscamos en los elementos raiz del POS.
    const posRoot = document.querySelector("div.pos") || document.querySelector("pos-root");

    // Si no encontramos el root, retornamos el documento como root y null como contenedor
    if (!posRoot) return {root: document, container: null};

    // Intentamos acceder al shadow DOM si existe
    const sr = posRoot.shadowRoot;
    if (sr) {
        // Buscamos el contenedor de la cabecera dentro del shadow DOM.
        const header = sr.querySelector(".pos-rightheader") || sr.querySelector(".header-buttons");

        // Retornamos el shadow root y el contenedor encontrado.
        return { root: sr, container: header };
    }
    // Si no hay shadow DOM, buscamos directamente en el DOM normal.
    const header = document.querySelector(".pos-rightheader") || document.querySelector(".header-buttons");
    
    // Retornamos el documento como root y el contenedor encontrado.
    return { root: document, container: header };
}

// Inserta el botón en el contenedor de la cabecera.
function insertButtonInto(headerRoot) {
    // Evitamos insertar el botón más de una vez.
    if (headerRoot.querySelector(".custom-sync-btn")) {
        return false;
    }

    // Creamos el botón, añadimos la clase custom y añadimos un icono.
    const btn = document.createElement("button");
    btn.className = "control-button custom-sync-btn";
    btn.innerHTML = '<i class="fa fa-refresh"></i> Sincronizar pedidos';
    btn.style.marginLeft = "8px";

    // Añadimos el evento click al botón.
    btn.onclick = async () => {
        try {
            // Indicamos que la sincronización está en curso deshabilitando el botón.
            btn.disabled = true;

            // Cambiamos el icono a un spinner y el texto.
            btn.innerHTML = '<i class="fa fa-spinner fa-spin"></i> Sincronizando...';

            // Llamamos a la función de sincronización de pedidos offline expuesta previamente.
            if (window.pos_store && typeof window.pos_store.sync_offline_orders === "function") {

                // Sobrescribimos temporalmente el método solo para esta invocación del botón.
                const originalSync = window.pos_store.sync_offline_orders;
                window.pos_store.sync_offline_orders = async function(...args) {
                    console.log("sync_offline_orders sobrescrito para el botón");
                    if (typeof originalSync === "function") {
                        try{
                            window.manual_sync_in_progress = true;
                            await originalSync.apply(this, args);
                            console.log("Sincronización manual completada, no se llama al originalSync.");
                        } catch (e) {
                            console.error("Error en la sincronización original:", e);
                        }
                    }
                    return Promise.resolve();
                };
                try {
                    await window.pos_store.sync_offline_orders();
                } finally {
                    // Restauramos el método original pase lo que pase.
                    window.pos_store.sync_offline_orders = originalSync;
                }

                alert("Sincronización completada");
            } else {
                // Si no existe la función, mostramos una alerta de error.
                alert("No se encuentra window.pos_store.sync_offline_orders()");
                console.warn("window.pos_store:", window.pos_store);
            }
        } catch (e) {
            console.error("Error sincronizando:", e);
            alert("Error al sincronizar: " + (e && e.message));
        } finally {
            // Restauramos el botón a su estado original.
            btn.disabled = false;
            // Restauramos el icono y el texto original.
            btn.innerHTML = '<i class="fa fa-refresh"></i> Sincronizar pedidos';
        }
    };
    // Insertamos el botón en la cabecera.
    headerRoot.appendChild(btn);
    console.log("✅ Botón 'Sincronizar pedidos' insertado.");
    return true;
}

// Intentamos insertar el botón periódicamente hasta que lo encontremos o agotemos los intentos.
let attempts = 0;
const maxAttempts = 40;
// Cada 250ms intentamos insertar el botón.
const interval = setInterval(() => {
    attempts += 1;
    // Buscamos la cabecera del POS.
    const { root, container } = findHeaderRoot();
    // Determinamos el contenedor donde insertar el botón.
    const header = container || (root && root.querySelector && (root.querySelector(".pos-rightheader") || root.querySelector(".header-buttons")));
    // Si encontramos la cabecera, intentamos insertar el botón.
    if (header) {
        // Insertamos el botón y si tuvo éxito, limpiamos el intervalo.
        const ok = insertButtonInto(header);
        if (ok) {
            clearInterval(interval);
        }
    }
    // Si agotamos los intentos, limpiamos el intervalo y mostramos una advertencia.
    if (attempts >= maxAttempts) {
        // Mostramos una advertencia en la consola.
        clearInterval(interval);
        console.warn("pos_offline: no se encontró la cabecera del POS para inyectar el botón (intentos agotados).");
    }
}, 250);
