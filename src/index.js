require('dotenv').config();
const { startWhatsApp } = require('./whatsapp');
const { startAPI } = require('./api');

async function main() {
  console.log('🚀 Iniciando WhatsApp Bot...');
  
  // Iniciar conexión de WhatsApp
  const sock = await startWhatsApp();
  
  // Iniciar servidor API para recibir comandos
  startAPI(sock);
  
  console.log('✅ Bot iniciado correctamente');
}

main().catch(console.error);
