/** @odoo-module **/

import { PosStore } from "@point_of_sale/app/store/pos_store";
import { patch } from "@web/core/utils/patch";

/*  Valores constantes de referencia a la base de datos. */
const DB_NAME = "POS_Order";
const STORE_NAME = "store1";
const DB_VERSION = 1;

patch(PosStore.prototype, {
    
    /*  Sobrescritura del setup, para cuando esté online, 
        use sync_offline_orders para sicronizar los datos. */
    async setup(...args){
        
        // Sobrescribe el método setup.
        await super.setup(...args);

        console.log("PosStore: Configurando sincronización de pedidos offline...");

        // Añadimos un evento al setup, que enlaza el setup
        // con la función sync_offline_orders.
        window.addEventListener('online', this.sync_offline_orders.bind(this));

        // Ejecuta la sincronización.
        this.sync_offline_orders();

    },

    /*  Sobre escritura de sync_offline_orders, 
        coge todos los pedidos sin sicronizar y los sincroniza. */
    async sync_offline_orders(){

        // Crea una constante de todos los pedidos que se obtienen del indexedDB.
        const offline_orders = await _get_orders_from_indexeddb()

        // Verificamos cuantos pedidos son.
        await check_offline_orders(offline_orders)
        
        // Prepara los pedidos para _flush_orders: asegura el id y añade export_as_JSON.
        const orders_to_sync = offline_orders.map(order_data => ({
            ...order_data,
            id: order_data.uid,
            export_as_JSON: () => order_data.data,
        }));

        let result = false;

        // Si no hay pedidos, sale de la función.
        if(offline_orders.length === 0){
            console.log("No hay pedidos para sincronizar.");
            return;
        }

        let tiempo = await time_sync();

        console.log(`Iniciando sincronización durante ${tiempo / 1000} segundos...`);

        try{
            
            // Marca el tiempo de inicio.
            const inicio = Date.now();
            sincronizar: while((true)){
                // Procesamos mientras haya pedidos en la cola, evitando mutar
                // el array durante una iteración for-of.
                while (orders_to_sync.length > 0) {
                    // Comprueba si se ha superado el tiempo máximo de sincronización.
                    const ahora = Date.now() - inicio;
                    if (ahora >= tiempo) {
                        console.log("Tiempo máximo de sincronización alcanzado.");
                        break sincronizar;
                    }

                    // Toma siempre el primer pedido de la cola.
                    const order = orders_to_sync[0];

                    // Espera 2 segundos entre cada intento para evitar saturar el servidor.
                    await new Promise(resolve => setTimeout(resolve, 2000));

                    try {
                        // Asignamos la uid y lo añadimos a la base de datos.
                        order.uid = order.data.uid;
                        this.db.add_order(order);

                        // Intentamos subir el pedido.
                        const subido = await super._flush_orders([order], { timeout: 5, shadow: false });
                        if (subido) { result = true; }

                        // Si se sube correctamente, lo borramos del indexedDB y de la base local de odoo.
                        await _clear_indexeddb_orders(order.uid);
                        await Promise.resolve(this.db.remove_order(order.uid));

                        // Eliminamos el primer elemento de la cola tras éxito.
                        orders_to_sync.shift();
                        offline_orders.shift();

                    } catch (error) {
                        console.warn(`Error al sincronizar pedido ${order && order.uid}:`, error);
                        // En caso de error de red o servidor, salimos para reintentar más tarde.
                        break sincronizar;
                    }
                }
                // Después de intentar sincronizar todos los pedidos,
                // comprobamos si quedan pedidos pendientes.
                const pendientes = await _get_orders_from_indexeddb();
                // Si no quedan pedidos, salimos del bucle y volvemos a modo online.
                if (pendientes.length === 0) {
                    console.log("Todos los pedidos sincronizados. Volviendo a modo online.");
                    window.dispatchEvent(new Event('online'));
                    break;
                } else { // Si quedan pedidos, mantenemos el modo offline.
                    console.log(`Quedan ${pendientes.length} pedidos en cola. Se mantiene modo offline.`);
                    break sincronizar;
                }
            }
            // Si no se han sincronizado todos los pedidos,
            // programa un nuevo intento en 30 minutos.
            if ((await _get_orders_from_indexeddb()).length > 0) {
                console.log("Reintentando sincronización en 30 minutos...");
                setTimeout(() => {
                    this.sync_offline_orders();
                }, 30*60*1000);
            }
        }catch(error){
            console.error("Error durante la sincronización de pedidos offline:", error);
            setTimeout(() => {
                    this.sync_offline_orders();
                }, 30*60*1000);
        }
    },

    /*  Sobrescritura de _flush_orders, intenta subir la orden, 
        sino hay conexión, usa el indexedDB para guardar los pedidos. */
    async _flush_orders(orders, options){
        try{

             // Comprobamos si hay pedidos pendientes en IndexedDB
            const pendientes = await _get_orders_from_indexeddb();

            if (pendientes.length > 0) {
                console.warn(`Hay ${pendientes.length} pedidos pendientes. Forzando modo offline.`);

                // Forzamos modo offline antes de intentar nada.
                window.dispatchEvent(new Event('offline'));

                // Guardamos los pedidos nuevos también en IndexedDB.
                await _save_orders_to_indexeddb(orders);

                // Limpiamos cache local de Odoo.
                await del_odoo_local(orders, this);

                // Devolvemos como si se hubiera guardado correctamente.
                return { successful: orders.map(o => ({ id: o.id, uid: o.uid })), failed: [] };
            }

            // Si hay conexión, envia los pedidos de manera habitual.
            return await super._flush_orders(orders,options)

        }catch(error){
            // Si el error es de conexión.
            if (error.message.includes('Connection') || error.message.includes('Network')) {

                console.warn("Conexión perdida. Guardando pedidos en IndexedDB.");
                
                // Guarda los pedidos en el indexedDB.
                await _save_orders_to_indexeddb(orders);

                // Borra las refernecias de local,
                // para evitar que haya no se sature
                // la memoria limitada del localstorage.
                await del_odoo_local(orders,this);

                // Forzamos el modo offline.
                window.dispatchEvent(new Event('offline'));


                console.log("Pedidos guardados localmente. Se sincronizarán cuando la conexión se restablezca.");
                
                // Devuelve que ha sido correcto el funcionamiento.
                return{ successful: orders.map(o =>({id: o.id, uid: o.uid})), 
                failed: [] };
            } else{
                throw error;
            }
        }
    },     
});

/*  Se utiliza para obtener todas las ordenes 
    que están en indexedDB. */
async function _get_orders_from_indexeddb(){
    try{
        // Coge la referencia de la base de datos.
        const db = await getIndexedDB();
        return new Promise((resolve, reject) => {

            // Comienza una transacción en la base de datos.
            const transaction = db.transaction([STORE_NAME], "readonly");
            const store = transaction.objectStore(STORE_NAME);

            // Creamos una lista que va a ser 
            // todos los pedidos de la base de datos.
            const orders = []; 

            // Usamos un cursor que va leyendo todos los pedidos 
            // y los va añadiendo a la lista, cuando no quedan, 
            // resulve la transacción.
            store.openCursor().onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    orders.push(cursor.value);
                    cursor.continue();
                } else {
                    resolve(orders);
                }
            };

            // Si da error, aborta la transacción.
            transaction.onerror = (e) =>{
                console.error("Error al recuperar de la BD");
                reject(e);
            };
        });
    }catch(e){
        console.error("Fallo crítico al acceder o guardar en IndexedDB:", e);
        throw new Error("IndexedDB get failed."); 
    }
}

/*  Función que obtiene la base de datos para poder modificarla. */
function getIndexedDB() {
    return new Promise((resolve, reject) => {
        // Abre la base de datos que está en indexedDB.
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        // Asignamos la id de la base de datos, para poder borrar uno a uno.
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'uid' });
            }
        };

        // Sino da error, resuelve la request.
        request.onsuccess = (e) =>resolve(e.target.result)

        // Si da error, aborta el intento de entrar.
        request.onerror = (e) =>{
            console.error("Error al abrir IndexedDB:", e.target.error);
            reject(e.target.error)
        }
    });
}

/*  Función usada para contar el número de ordenes offline que hay. */
async function check_offline_orders(offline_orders) {
    console.log("Comprobando conexión y pedidos pendientes en IndexedDB...");

    // Comprueba que haya al menos un pedido.
    if(offline_orders.length === 0){
        console.log("No hay pedidos pendientes en IndexedDB.");
        return;
    }

    // Imprimir el número de pedidos que hay.
    console.log(`Encontrados ${offline_orders.length} pedidos pendientes en IndexedDB. Intentando sincronizar...`);
}

/*  Se utiliza para borrar los datos que del indexedDB
    en el momento que se sincronizan con la base de datos de odoo. */
async function _clear_indexeddb_orders(uid){
    try{
        // Coge la referencia de la base de datos.
        const db = await getIndexedDB();
        return new Promise((resolve, reject) => {
            // Comienza una transacción a la tabla de la base.
            const transaction = db.transaction([STORE_NAME],"readwrite");
            const store = transaction.objectStore(STORE_NAME);

            // Elimina solo el registro con id ese id
            const clearRequest = store.delete(uid);

            // Sino da error, resuelve la transacción.
            clearRequest.onsuccess = () =>{
                console.log(`Pedido con uid ${uid} eliminado de IndexedDB.`);
                resolve();
            };

            // Si da error, aborta la transacción.
            clearRequest.onerror = (e) =>{
                reject(e);
            };
        });
    }catch(e){
        console.error("Fallo crítico al acceder o guardar en IndexedDB:", e);
        throw new Error("IndexedDB clear failed.");
    }
}

/*  Función utilizada para guardar las ordenes 
    cuando no hay conexión en indexedDB. */
async function _save_orders_to_indexeddb(orders){
    try{

        // Coge la referencia de la base de datos.
        const db = await getIndexedDB();
        return new Promise((resolve, reject) => {

            // Comienza una transacción a la tabla de la base.
            const transaction = db.transaction([STORE_NAME],"readwrite");
            const store = transaction.objectStore(STORE_NAME);
            
            let orders_indexed = 0;
            // Por cada pedido que tiene la base de datos, 
            // guarda la id y sus datos en el indexed.
            orders.forEach(order => {
                store.put({id: order.id, uid: order.uid, data: order.data});
                orders_indexed++;
            });

            // Si la transacción se completa, 
            // pone un log con el numero de ordenes indexadas.
            transaction.oncomplete = () =>{
                console.log(`Ordenes indexadas:  ${orders_indexed}`);
                console.log(`Ordenes indexadas:  ${orders.length}`);
                resolve();
            };

            // Si la transacción da error, 
            // aborta la transacción.
            transaction.onerror = (e) =>{
                console.error("Error al indexar en la BD");
                reject(e);
            };
        });
    }catch(e){
        console.error("Fallo crítico al acceder o guardar en IndexedDB:", e);
        throw new Error("IndexedDB save failed."); 
    }
}

/*  Función usada para borrar todos los datos y 
    referencias que guarda odoo  offline. */
async function del_odoo_local(orders, posStore){
    
    // Un bucle que es utilizado para borrar 
    // las referencias de la base de datos de odoo.
    orders.forEach(order => {
                posStore.db.remove_order(order.uid);
                console.log(`Pedido ${order.uid} eliminado forzosamente de la BD local de Odoo.`);
            });

    // Este apartado usa el nombre de paidOrderKey en 
    // el local storage para borrar esa referencia.
    const paidOrdersKey = posStore.db.name + '_orders';
    localStorage.removeItem(paidOrdersKey);
    console.log(`Clave '${paidOrdersKey}' eliminada del Local Storage.`);
    
    // Este apartado usa la referencia del pendingOperationsKEt 
    // para borrarla ene l local storage.
    const pendingOperationsKey = posStore.db.name + '_pending_operations';
    localStorage.removeItem(pendingOperationsKey);
    console.log(`Clave de operaciones pendientes ('${pendingOperationsKey}') eliminada del Local Storage.`);
}

async function time_sync(){
    console.log("Sincronizando hora con el servidor...");

    return new Promise((resolve, reject) => {
        setTimeout(() => {
            const time_for_out = 150000; // 150 segundos
            resolve(time_for_out);
        }, 1000);
    });
}