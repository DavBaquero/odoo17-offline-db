/** @odoo-module **/

import { PosStore } from "@point_of_sale/app/store/pos_store";
import { patch } from "@web/core/utils/patch";

console.log("Loading OfflineSync for Odoo 17 POS");


const DB_NAME = "POS_Order";
const STORE_NAME = "store1";
const DB_VERSION = 1;

function getIndexedDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onsuccess = (e) =>resolve(e.target.result)
        request.onerror = (e) =>{
            console.error("Error al abrir IndexedDB:", e.target.error);
            reject(e.target.error)
        }
    });
    
}

async function _save_orders_to_indexeddb(orders){
    try{
        const db = await getIndexedDB();
        return new Promise((resolve, reject) => {
            
            const transaction = db.transaction([STORE_NAME],"readwrite");
            const store = transaction.objectStore(STORE_NAME);

            orders.forEach(order => {
                store.put({id: order.id, data: order.data});
            });
            transaction.oncomplete = () =>{
                console.log(`Ordenes indexadas:  ${orders.length}`);
                resolve();
            };

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

async function _get_orders_from_indexeddb(){
    try{
        const db = await getIndexedDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], "readonly");
            const store = transaction.objectStore(STORE_NAME);
            const orders = [];

            store.openCursor().onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    orders.push(cursor.value);
                    cursor.continue();
                } else {
                    resolve(orders);
                }
            };

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

patch(PosStore.prototype, {
    async _flush_orders(orders, options){

        console.log("Comprobando conexión y pedidos pendientes en IndexedDB...");
        if(!navigator.onLine){
            console.warn("Sin conexión a Internet. Guardando pedidos en IndexedDB.");
        }

        const offline_orders = await _get_orders_from_indexeddb();

        if(offline_orders.length === 0){
            console.log("No hay pedidos pendientes en IndexedDB.");
        }
        
        try{

            return await super._flush_orders(orders,options)

        }catch(error){
            if (error.message.includes('Connection')){

                console.warn("Conexión perdida. Guardando pedidos en IndexedDB.");
                

                await _save_orders_to_indexeddb(orders);              
                
                orders.forEach(order => {
                    this.db.remove_order(order.id);
                    console.log(`Pedido ${order.id} eliminado forzosamente de la BD local de Odoo.`);
                });

                const paidOrdersKey = this.db.name + '_orders';
                localStorage.removeItem(paidOrdersKey);
                console.log(`Clave '${paidOrdersKey}' eliminada del Local Storage.`);

                const pendingOperationsKey = this.db.name + '_pending_operations';
                localStorage.removeItem(pendingOperationsKey);
                console.log(`Clave de operaciones pendientes ('${pendingOperationsKey}') eliminada del Local Storage.`);

                console.log("Pedidos guardados localmente. Se sincronizarán cuando la conexión se restablezca.");

                const offline_orders = await _get_orders_from_indexeddb();
                
                console.log(`Encontrados ${offline_orders.length} pedidos pendientes en IndexedDB. Intentando sincronizar...`);

                return{ successful: orders.map(o => ({id: o.id})), 
                failed: [] };
            } else{
                throw error;
            }
        }
    },    
});
