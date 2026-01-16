const { 
  default: makeWASocket, 
  DisconnectReason, 
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const fetch = require('node-fetch');

const WEBHOOK_URL = process.env.WEBHOOK_URL;

// Almacenar círculos conectados (circle_id -> group_jid)
const connectedCircles = new Map();

async function sendToWebhook(data) {
  try {
    const response = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const result = await response.json();
    console.log('📤 Webhook response:', result);
    return result;
  } catch (error) {
    console.error('❌ Error sending to webhook:', error.message);
    return null;
  }
}

async function startWhatsApp() {
  const logger = pino({ level: 'silent' });
  
  // Cargar estado de autenticación
  const { state, saveCreds } = await useMultiFileAuthState('./auth_state');
  
  // Obtener última versión de Baileys
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`📱 Usando WA v${version.join('.')}, última: ${isLatest}`);

  // Crear socket de WhatsApp
  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    generateHighQualityLinkPreview: true,
  });

  // Manejar actualizaciones de conexión
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr) {
      console.log('\n📱 Escanea este código QR con WhatsApp:\n');
      qrcode.generate(qr, { small: true });
      console.log('\n⏳ Esperando escaneo...\n');
    }
    
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('🔌 Conexión cerrada, reconectando:', shouldReconnect);
      
      if (shouldReconnect) {
        setTimeout(() => startWhatsApp(), 5000);
      } else {
        console.log('❌ Sesión cerrada. Elimina la carpeta auth_state y reinicia.');
      }
    } else if (connection === 'open') {
      console.log('✅ Conectado a WhatsApp!');
      console.log('📞 Número:', sock.user?.id?.split(':')[0]);
    }
  });

  // Guardar credenciales cuando se actualicen
  sock.ev.on('creds.update', saveCreds);

  // Escuchar mensajes entrantes
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    
    for (const msg of messages) {
      // Ignorar mensajes propios y de status
      if (msg.key.fromMe) continue;
      if (msg.key.remoteJid === 'status@broadcast') continue;
      
      // Solo procesar mensajes de grupos
      const isGroup = msg.key.remoteJid?.endsWith('@g.us');
      if (!isGroup) continue;
      
      // Buscar el circle_id asociado a este grupo
      let circleId = null;
      for (const [cId, gJid] of connectedCircles.entries()) {
        if (gJid === msg.key.remoteJid) {
          circleId = cId;
          break;
        }
      }
      
      if (!circleId) {
        console.log('⚠️ Mensaje de grupo no registrado:', msg.key.remoteJid);
        continue;
      }
      
      // Extraer contenido del mensaje
      const content = msg.message?.conversation || 
                      msg.message?.extendedTextMessage?.text ||
                      msg.message?.imageMessage?.caption ||
                      msg.message?.videoMessage?.caption ||
                      '';
      
      if (!content) continue;
      
      // Obtener información del remitente
      const senderPhone = msg.key.participant?.split('@')[0] || msg.key.remoteJid?.split('@')[0];
      const senderName = msg.pushName || senderPhone;
      
      console.log(`📨 [${circleId}] ${senderName}: ${content.substring(0, 50)}...`);
      
      // Enviar al webhook
      await sendToWebhook({
        action: 'message',
        circle_id: circleId,
        whatsapp_message_id: msg.key.id,
        sender_phone: senderPhone,
        sender_name: senderName,
        content: content,
      });
    }
  });

  // Exponer funciones útiles
  sock.joinGroup = async (circleId, inviteLink) => {
    try {
      // Extraer código de invitación del link
      const inviteCode = inviteLink.split('chat.whatsapp.com/')[1];
      if (!inviteCode) {
        throw new Error('Link de invitación inválido');
      }
      
      console.log(`🔗 Intentando unirse con código: ${inviteCode}`);
      
      // Unirse al grupo
      const groupJid = await sock.groupAcceptInvite(inviteCode);
      console.log(`✅ Unido al grupo: ${groupJid}`);
      
      // Registrar la conexión
      connectedCircles.set(circleId, groupJid);
      
      // Obtener info del grupo
      const groupMeta = await sock.groupMetadata(groupJid);
      
      return {
        success: true,
        group_id: groupJid,
        group_name: groupMeta.subject,
        member_count: groupMeta.participants.length,
      };
    } catch (error) {
      console.error('❌ Error al unirse al grupo:', error.message);
      return {
        success: false,
        error: error.message,
      };
    }
  };

  sock.leaveGroup = async (circleId) => {
    try {
      const groupJid = connectedCircles.get(circleId);
      if (!groupJid) {
        throw new Error('Círculo no encontrado');
      }
      
      await sock.groupLeave(groupJid);
      connectedCircles.delete(circleId);
      
      return { success: true };
    } catch (error) {
      console.error('❌ Error al salir del grupo:', error.message);
      return { success: false, error: error.message };
    }
  };

  sock.sendGroupMessage = async (circleId, message) => {
    try {
      const groupJid = connectedCircles.get(circleId);
      if (!groupJid) {
        throw new Error('Círculo no encontrado');
      }
      
      await sock.sendMessage(groupJid, { text: message });
      return { success: true };
    } catch (error) {
      console.error('❌ Error al enviar mensaje:', error.message);
      return { success: false, error: error.message };
    }
  };

  sock.getConnectedCircles = () => {
    return Array.from(connectedCircles.entries()).map(([circleId, groupJid]) => ({
      circle_id: circleId,
      group_jid: groupJid,
    }));
  };

  return sock;
}

module.exports = { startWhatsApp };
