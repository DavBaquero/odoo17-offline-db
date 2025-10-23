

/*  Intenta abrir la base de datos de indexedDB */
var request = indexedDB.open("POS_Order",1);

/*  En el caso de que no exista, 
    crea la tabla que va a usar para guardar datos */
request.onupgradeneeded = function(e) {
    console.log("Creando o abriendo la DB POS_Order");
    e.target.result.createObjectStore("store1",{keyPath:"id"});
};

request.onsuccess = function(e){
    console.log("IndexedDB creada o abierta con éxito");
};

request.onerror = function(e){
    console.error("Error al abrir IndexedDB:", e.target.errorCode);
};