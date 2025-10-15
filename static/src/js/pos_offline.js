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

patch(PosStore.prototype, {
    async _flush_orders(orders, options){
        
        try{
            return await super._flush_orders(orders,options)
        }catch(error){
            if (error.message.includes('Connection')){
                console.warn("Conexión perdida. Guardando pedidos en IndexedDB.");
                await _save_orders_to_indexeddb(orders);
                return{ successful: orders.map(o => ({id: o.id})), 
                failed: [] };
            } else{
                throw error;
            }
        };
    },    
});
