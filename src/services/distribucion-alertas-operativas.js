"use strict";
function distancia(a,b){const rad=x=>x*Math.PI/180,dlat=rad(a.latitud-b.latitud),dlon=rad(a.longitud-b.longitud),h=Math.sin(dlat/2)**2+Math.cos(rad(a.latitud))*Math.cos(rad(b.latitud))*Math.sin(dlon/2)**2;return 6371000*2*Math.atan2(Math.sqrt(h),Math.sqrt(Math.max(0,1-h)));}
// GPS descendente: no se puentean huecos de más de cinco minutos.
function detencion(puntos,ahora,minutos){
 const ultimo=puntos[0];if(!ultimo||ahora-new Date(ultimo.fecha)>120000)return false;
 let anterior=new Date(ultimo.fecha);
 for(const p of puntos){const fecha=new Date(p.fecha);
  if(p.precision_metros>60||p.precision_metros==null||p.velocidad==null||p.velocidad>5||anterior-fecha>300000||distancia(ultimo,p)>100)return false;
  if(new Date(ultimo.fecha)-fecha>=minutos*60000)return true;
  anterior=fecha;
 }
 return false;
}
module.exports={detencion};
