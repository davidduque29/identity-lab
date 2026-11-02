'use strict';
const $=id=>document.getElementById(id);
let stream=null, references=[], busy=false, generation=0, loaded=false, modelPromise=null;
const adapter={
 name:'face-api.js / FaceRecognitionNet',
 async load(){
  if(loaded)return;
  if(!window.faceapi)throw new Error('No se pudo cargar el motor de reconocimiento. Recarga la página.');
  if(!modelPromise)modelPromise=Promise.all([faceapi.nets.tinyFaceDetector.loadFromUri('./models'),faceapi.nets.faceLandmark68Net.loadFromUri('./models'),faceapi.nets.faceRecognitionNet.loadFromUri('./models')]).then(()=>{loaded=true;}).catch(e=>{modelPromise=null;throw e;});
  await modelPromise;
 },
 async capture(){
  const video=$('video');
  if(!stream||video.readyState<2||!video.videoWidth)throw new Error('La cámara todavía no está lista. Espera un momento.');
  const canvas=document.createElement('canvas');canvas.width=video.videoWidth;canvas.height=video.videoHeight;
  canvas.getContext('2d').drawImage(video,0,0);
  const found=await faceapi.detectAllFaces(canvas,new faceapi.TinyFaceDetectorOptions({inputSize:416,scoreThreshold:.6})).withFaceLandmarks().withFaceDescriptors();
  canvas.width=0;canvas.height=0;
  if(found.length===0)throw new Error('No se detectó un rostro. Acércate y mejora la iluminación.');
  if(found.length!==1)throw new Error('Debe aparecer una sola persona. Retira los otros rostros del encuadre.');
  if(found[0].detection.box.width/video.videoWidth<.18)throw new Error('Tu rostro está muy lejos. Acércate un poco.');
  return found[0].descriptor;
 },
 distance(a,b){return faceapi.euclideanDistance(a,b);}
};
function log(message){const li=document.createElement('li'),time=document.createElement('time');time.textContent=new Date().toLocaleTimeString('es-CO',{hour:'2-digit',minute:'2-digit',second:'2-digit'});li.append(time,document.createTextNode(message));$('log').prepend(li);while($('log').children.length>20)$('log').lastChild.remove();}
function status(message){$('status').textContent=message;$('stepStatus').textContent=message;}
function controls(){const ready=!!stream&&!busy;$('start').disabled=busy||!!stream;$('stop').disabled=!stream;$('enroll').disabled=!ready||!loaded;$('verify').disabled=!ready||!loaded||!references.length;$('consent').disabled=!!stream||busy;$('captureHere').disabled=!ready||!loaded;$('compareHere').disabled=!ready||!loaded||!references.length;$('captureHere').textContent=busy?'Procesando…':references.length?'Volver a registrar mi rostro':'Capturar y registrar mi rostro';}
function result(title,body,kind='',distance){$('result').className='result '+kind;$('result').replaceChildren();const e=document.createElement('span');e.className='eyebrow';e.textContent='RESULTADO';const h=document.createElement('h3');h.textContent=title;const p=document.createElement('p');p.textContent=body;$('result').append(e,h);if(distance!==undefined){const n=document.createElement('strong');n.textContent=distance.toFixed(3);$('result').append(n);}$('result').append(p);}
function stop(){generation++;if(stream){stream.getTracks().forEach(t=>t.stop());stream=null;}$('video').srcObject=null;$('empty').style.display='flex';$('cameraStatus').textContent='Cámara apagada';busy=false;controls();}
async function start(){if(!$('consent').checked){status('Marca la autorización antes de activar la cámara.');$('consent').focus();return;}if(!navigator.mediaDevices?.getUserMedia){status('La cámara no está disponible. Abre el enlace en Safari, Chrome o Edge mediante HTTPS.');return;}busy=true;controls();status('Solicitando permiso de cámara y cargando los modelos…');const token=++generation;
 try{await adapter.load();if(token!==generation)return;const incoming=await navigator.mediaDevices.getUserMedia({video:{facingMode:'user',width:{ideal:640},height:{ideal:480}},audio:false});if(token!==generation){incoming.getTracks().forEach(t=>t.stop());return;}stream=incoming;$('video').srcObject=stream;await $('video').play();if(token!==generation)return;$('empty').style.display='none';$('cameraStatus').textContent='Cámara activa';status('Cámara lista. Pulsa «Capturar y registrar mi rostro», aquí arriba.');log('Cámara activada. Motor local listo; ninguna captura se ha enviado al servidor.');}
 catch(e){if(token!==generation)return;stop();const message=e.name==='NotAllowedError'?'Permiso denegado. Habilita la cámara en el navegador y vuelve a intentarlo.':e.name==='NotFoundError'?'No encontramos una cámara. Conecta una webcam o abre el enlace en el celular.':e.name==='NotReadableError'?'La cámara está ocupada por otra aplicación. Ciérrala y vuelve a intentarlo.':e.message;status(message);log(message);}
 finally{if(token===generation||!stream){busy=false;controls();}}
}
async function enroll(){if(busy||!stream)return;busy=true;controls();const token=generation;const samples=[];try{for(let i=0;i<3;i++){status('Registrando muestra '+(i+1)+' de 3. Mantén el rostro centrado…');samples.push(await adapter.capture());if(token!==generation)return;await new Promise(r=>setTimeout(r,250));if(token!==generation)return;}references=samples;$('reference').textContent='✓ Referencia activa · 3 muestras · 128 valores por muestra';result('Referencia registrada','Ya puedes realizar una comparación. Las muestras duran solo esta sesión.');status('Registro completado. Ahora puedes comparar una captura nueva.');log('Referencia registrada: tres vectores de 128 valores, solo en memoria.');}catch(e){if(token===generation){status(e.message);result('Registro incompleto',e.message,'fail');log('Registro incompleto: '+e.message);}}finally{if(token===generation){busy=false;controls();}}}
async function verify(){if(busy||!stream||!references.length)return;busy=true;controls();const token=generation;const threshold=Number($('threshold').value);try{status('Analizando una captura nueva…');const descriptor=await adapter.capture();if(token!==generation)return;const distances=references.map(ref=>adapter.distance(ref,descriptor));const distance=distances.reduce((a,b)=>a+b,0)/distances.length;const match=distance<=threshold;result(match?'Coincidencia según el umbral':'Sin coincidencia según el umbral','Distancia media: '+distance.toFixed(3)+' · Umbral usado: '+threshold.toFixed(2)+'. Resultado experimental; no verifica presencia real.',match?'success':'fail',distance);status('Comparación completada. Puedes repetirla o registrar otra referencia.');log((match?'Coincidencia':'Sin coincidencia')+' · distancia '+distance.toFixed(3)+' · umbral '+threshold.toFixed(2));}catch(e){if(token===generation){status(e.message);result('No se pudo comparar',e.message);log('Comparación incompleta: '+e.message);}}finally{if(token===generation){busy=false;controls();}}}
$('captureHere').addEventListener('click',enroll);$('compareHere').addEventListener('click',verify);$('start').addEventListener('click',start);$('stop').addEventListener('click',()=>{stop();status('Cámara apagada. Puedes volver a activarla.');log('Cámara apagada.');});$('enroll').addEventListener('click',enroll);$('verify').addEventListener('click',verify);
$('threshold').addEventListener('input',()=>{$('thresholdValue').value=Number($('threshold').value).toFixed(2);});
$('reset').addEventListener('click',()=>{stop();references.forEach(x=>x.fill(0));references=[];$('reference').textContent='Sin referencia registrada';$('log').replaceChildren();result('Esperando tu primera comparación','Aquí verás la distancia entre los vectores faciales.');status('Referencia y resultados borrados. La cámara está apagada.');controls();});
document.addEventListener('visibilitychange',()=>{if(document.hidden&&stream){stop();status('Cámara apagada al salir de la página.');}});window.addEventListener('pagehide',()=>{stop();references.forEach(x=>x.fill(0));references=[];});controls();
status('Preparando el motor local de reconocimiento…');
adapter.load().then(()=>{if(!stream&&!busy)status('Motor local listo. Autoriza y activa la cámara para comenzar.');log('Modelos de detección, puntos faciales y reconocimiento cargados.');controls();}).catch(e=>{status('No se pudo preparar el motor: '+e.message);log('Error al cargar modelos. Puedes reintentar activando la cámara.');});
