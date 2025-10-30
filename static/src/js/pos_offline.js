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
        

        try{
            let result = false;

            if(offline_orders.length === 0){
                result = true
            }
            
            // Añade los pedidos a la base de datos local de Odoo, para que los reconozca.
            for(const order of orders_to_sync){
                // Añade el pedido a la base de datos local de Odoo.
                this.db.add_order(order);
                // Intenta subir el pedido.
                await super._flush_orders([order], {timeout: 5, shadow: false});
                result = true;
            }

            if(result && offline_orders.length === 0){
                console.log("Módulo funcionando")
            }else if(result){
                // Si funciona, elimina los pedidos de la base de datos local de Odoo.
                for(const order of orders_to_sync){
                    // Se asigna la uid para eliminar correctamente.
                    order.uid = order.data.uid;
                    // Elimina el pedido de la base de datos local de Odoo,
                    // para evitar duplicados y el mensaje de sincronización.
                    this.db.remove_order(order.uid);
                }
                // Si funciona, vacía el indexedDB, para evitar duplicados en caso de que se caiga otra vez.
                console.log("Sincronizacion completada, Vaciando indexedDB...");
                await _clear_indexeddb_orders();
                                
            } else {
                // Si falla, continuan los datos en indexedDB.
                console.error("Falló la sincronización, se mantedrán en indexedDB.", result.failed);
            }
        }catch(error){
            console.error("Error durante la sincronización de pedidos offline:", error);
        }
    },

    /*  Sobrescritura de _flush_orders, intenta subir la orden, 
        sino hay conexión, usa el indexedDB para guardar los pedidos. */
    async _flush_orders(orders, options){
        try{

            // Si hay conexión, envia los pedidos de manera habitual.
            return await super._flush_orders(orders,options)

        }catch(error){
            // Si el error es de conexión.
            if (error.message.includes('Connection')){

                console.warn("Conexión perdida. Guardando pedidos en IndexedDB.");
                
                // Guarda los pedidos en el indexedDB.
                await _save_orders_to_indexeddb(orders);

                // Borra las refernecias de local,
                // para evitar que haya no se sature
                // la memoria limitada del localstorage.
                await del_odoo_local(orders,this);

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
async function _clear_indexeddb_orders(){
    try{
        // Coge la referencia de la base de datos.
        const db = await getIndexedDB();
        return new Promise((resolve, reject) => {
            // Comienza una transacción a la tabla de la base.
            const transaction = db.transaction([STORE_NAME],"readwrite");
            const store = transaction.objectStore(STORE_NAME);

            // Vacía el indexedDB.
            const clearRequest = store.clear();

            // Sino da error, resuelve la transacción.
            clearRequest.onsuccess = () =>{
                console.log("Almacén de IndexedDB vaciado con éxito.");
                resolve();
            };

            // Si da error, aborta la transacción.
            clearRequest.onerror = (e) =>{
                console.error("Error al vaciar la BD");
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