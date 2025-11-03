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

function insertButtonInto(headerRoot) {
    if (headerRoot.querySelector(".custom-sync-btn")) {
        return false;
    }

    const btn = document.createElement("button");
    btn.className = "control-button custom-sync-btn";
    btn.innerHTML = '<i class="fa fa-refresh"></i> Sincronizar pedidos';
    btn.style.marginLeft = "8px";

    btn.onclick = async () => {
        try {
            btn.disabled = true;
            btn.innerHTML = '<i class="fa fa-spinner fa-spin"></i> Sincronizando...';
            if (window.pos_store && typeof window.pos_store.sync_offline_orders === "function") {
                await window.pos_store.sync_offline_orders();
                alert("✅ Sincronización completada");
            } else {
                alert("⚠️ No se encuentra window.pos_store.sync_offline_orders()");
                console.warn("window.pos_store:", window.pos_store);
            }
        } catch (e) {
            console.error("Error sincronizando:", e);
            alert("❌ Error al sincronizar: " + (e && e.message));
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa fa-refresh"></i> Sincronizar pedidos';
        }
    };

    headerRoot.appendChild(btn);
    console.log("✅ Botón 'Sincronizar pedidos' insertado.");
    return true;
}
let attempts = 0;
const maxAttempts = 40; // 40 * 250ms = 10s
const interval = setInterval(() => {
    attempts += 1;
    const { root, container } = findHeaderRoot();
    const header = container || (root && root.querySelector && (root.querySelector(".pos-rightheader") || root.querySelector(".header-buttons")));
    if (header) {
        const ok = insertButtonInto(header);
        if (ok) {
            clearInterval(interval);
        }
    }
    if (attempts >= maxAttempts) {
        clearInterval(interval);
        console.warn("pos_offline: no se encontró la cabecera del POS para inyectar el botón (intentos agotados).");
    }
}, 250);
