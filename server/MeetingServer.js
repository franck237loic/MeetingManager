/**
 * MeetingServer.js
 * Classe principale du serveur WebSocket pour MeetingProject
 * Ce serveur gère les connexions WebSocket des clients Cordova
 */

const WebSocket = require('ws');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');

// Chargement des variables d'environnement
dotenv.config();

class MeetingServer {
    constructor() {
        this.port = process.env.WS_PORT || 8080;
        this.host = process.env.WS_HOST || 'localhost';
        this.wss = null;
        this.clients = new Map(); // Stocke les clients connectés
        this.meetings = []; // Stocke les réunions
        this.meetingsFile = path.join(__dirname, 'data', 'meetings.json');
        this.fileLock = false; // Verrou pour éviter les écritures concurrentes
    }

    /**
     * Démarre le serveur WebSocket
     */
    start() {
        try {
            // Charger les réunions depuis le fichier
            this.loadMeetings();

            this.wss = new WebSocket.Server({
                host: this.host,
                port: this.port
            });

            console.log(`[MeetingServer] Démarrage sur ws://${this.host}:${this.port}`);

            this.wss.on('listening', () => {
                console.log(`[MeetingServer] Serveur WebSocket en écoute sur ${this.host}:${this.port}`);
            });

            this.wss.on('connection', (ws, req) => {
                this.handleConnection(ws, req);
            });

            this.wss.on('error', (error) => {
                console.error('[MeetingServer] Erreur du serveur WebSocket:', error.message);
            });

        } catch (error) {
            console.error('[MeetingServer] Erreur lors du démarrage:', error.message);
            throw error;
        }
    }

    /**
     * Gère une nouvelle connexion client
     * @param {WebSocket} ws - WebSocket du client
     * @param {IncomingMessage} req - Requête HTTP de connexion
     */
    handleConnection(ws, req) {
        const clientId = this.generateClientId();
        const clientIp = req.socket.remoteAddress;

        console.log(`[MeetingServer] Nouveau client connecté: ${clientId} depuis ${clientIp}`);

        // Stocker le client
        this.clients.set(clientId, {
            ws: ws,
            ip: clientIp,
            connectedAt: new Date()
        });

        // Envoyer un message de bienvenue
        this.sendToClient(ws, {
            type: 'connection',
            status: 'connected',
            clientId: clientId,
            message: 'Bienvenue sur le serveur Meeting'
        });

        // Écouter les messages du client
        ws.on('message', (data) => {
            this.handleMessage(ws, clientId, data);
        });

        // Gérer la déconnexion
        ws.on('close', () => {
            this.handleDisconnection(clientId);
        });

        // Gérer les erreurs du client
        ws.on('error', (error) => {
            console.error(`[MeetingServer] Erreur client ${clientId}:`, error.message);
        });
    }

    /**
     * Gère les messages reçus d'un client
     * @param {WebSocket} ws - WebSocket du client
     * @param {string} clientId - Identifiant du client
     * @param {Buffer|string} data - Données reçues
     */
    handleMessage(ws, clientId, data) {
        try {
            const message = JSON.parse(data.toString());
            console.log(`[MeetingServer] Message reçu de ${clientId}:`, message.type);

            // Répondre au ping
            if (message.type === 'ping') {
                this.sendToClient(ws, {
                    type: 'pong',
                    timestamp: new Date().toISOString()
                });
                return;
            }

            // === MODULE 2: GESTION DES RÉUNIONS ===
            
            // Création d'une réunion
            if (message.type === 'CREATE_MEETING') {
                this.handleCreateMeeting(ws, clientId, message);
                return;
            }

            // Récupération des réunions
            if (message.type === 'GET_MEETINGS') {
                this.handleGetMeetings(ws, clientId, message);
                return;
            }

            // Récupération des détails d'une réunion
            if (message.type === 'GET_MEETING_DETAILS') {
                this.handleGetMeetingDetails(ws, clientId, message);
                return;
            }

            // Modification d'une réunion
            if (message.type === 'UPDATE_MEETING') {
                this.handleUpdateMeeting(ws, clientId, message);
                return;
            }

            // Annulation d'une réunion
            if (message.type === 'CANCEL_MEETING') {
                this.handleCancelMeeting(ws, clientId, message);
                return;
            }

            // Message non reconnu
            console.warn(`[MeetingServer] Type de message non reconnu: ${message.type}`);
            this.sendToClient(ws, {
                type: 'error',
                requestId: message.requestId,
                error: 'Type de message non reconnu'
            });

        } catch (error) {
            console.error(`[MeetingServer] Erreur parsing message de ${clientId}:`, error.message);
            this.sendToClient(ws, {
                type: 'error',
                error: 'Erreur de parsing du message'
            });
        }
    }

    /**
     * Gère la déconnexion d'un client
     * @param {string} clientId - Identifiant du client
     */
    handleDisconnection(clientId) {
        console.log(`[MeetingServer] Client déconnecté: ${clientId}`);
        this.clients.delete(clientId);
    }

    /**
     * Envoie un message à un client spécifique
     * @param {WebSocket} ws - WebSocket du client
     * @param {object} message - Message à envoyer
     */
    sendToClient(ws, message) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(message));
        } else {
            console.warn('[MeetingServer] Impossible d\'envoyer: WebSocket non ouvert');
        }
    }

    /**
     * Génère un identifiant unique pour un client
     * @returns {string} Identifiant unique
     */
    generateClientId() {
        return 'client_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    }

    // ==================== MODULE 2: GESTION DES RÉUNIONS ====================

    /**
     * Charge les réunions depuis le fichier JSON
     */
    loadMeetings() {
        try {
            if (fs.existsSync(this.meetingsFile)) {
                const data = fs.readFileSync(this.meetingsFile, 'utf8');
                const parsed = JSON.parse(data);
                this.meetings = parsed.meetings || [];
                console.log(`[MeetingServer] ${this.meetings.length} réunion(s) chargée(s) depuis le fichier`);
            } else {
                this.meetings = [];
                console.log('[MeetingServer] Fichier meetings.json inexistant, création d\'une nouvelle liste');
                this.saveMeetings();
            }
        } catch (error) {
            console.error('[MeetingServer] Erreur lors du chargement des réunions:', error.message);
            this.meetings = [];
        }
    }

    /**
     * Sauvegarde les réunions dans le fichier JSON
     */
    async saveMeetings() {
        // Attendre si une écriture est en cours
        while (this.fileLock) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        this.fileLock = true;

        try {
            const data = {
                meetings: this.meetings,
                lastUpdated: new Date().toISOString()
            };

            // S'assurer que le dossier existe
            const dir = path.dirname(this.meetingsFile);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            // Écrire de manière atomique
            const tempFile = this.meetingsFile + '.tmp';
            fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), 'utf8');
            fs.renameSync(tempFile, this.meetingsFile);

            console.log(`[MeetingServer] ${this.meetings.length} réunion(s) sauvegardée(s)`);
        } catch (error) {
            console.error('[MeetingServer] Erreur lors de la sauvegarde des réunions:', error.message);
        } finally {
            this.fileLock = false;
        }
    }

    /**
     * Génère un identifiant unique pour une réunion
     * @returns {string} Identifiant unique
     */
    generateMeetingId() {
        return 'meeting_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    }

    /**
     * Valide les données d'une réunion
     * @param {object} meetingData - Données de la réunion
     * @returns {object} { valid: boolean, errors: string[] }
     */
    validateMeetingData(meetingData) {
        const errors = [];

        if (!meetingData.title || meetingData.title.trim().length === 0) {
            errors.push('Le titre est obligatoire');
        }

        if (!meetingData.startDateTime) {
            errors.push('La date de début est obligatoire');
        } else {
            const startDate = new Date(meetingData.startDateTime);
            if (isNaN(startDate.getTime())) {
                errors.push('La date de début est invalide');
            } else if (startDate < new Date()) {
                errors.push('La date de début doit être dans le futur');
            }
        }

        if (!meetingData.duration || meetingData.duration <= 0) {
            errors.push('La durée doit être positive');
        }

        if (!meetingData.meetingType || !['audio', 'video'].includes(meetingData.meetingType)) {
            errors.push('Le type de réunion doit être "audio" ou "video"');
        }

        if (!meetingData.maxParticipants || meetingData.maxParticipants <= 0) {
            errors.push('Le nombre maximum de participants doit être positif');
        }

        if (!meetingData.organizerId || meetingData.organizerId.trim().length === 0) {
            errors.push('L\'identifiant de l\'organisateur est obligatoire');
        }

        return {
            valid: errors.length === 0,
            errors: errors
        };
    }

    /**
     * Gère la création d'une réunion
     * @param {WebSocket} ws - WebSocket du client
     * @param {string} clientId - Identifiant du client
     * @param {object} message - Message reçu
     */
    async handleCreateMeeting(ws, clientId, message) {
        try {
            console.log('[MeetingServer] Création de réunion demandée par', clientId);

            const validation = this.validateMeetingData(message.data);
            if (!validation.valid) {
                this.sendResponse(ws, message.requestId, false, null, validation.errors.join(', '));
                return;
            }

            const startDate = new Date(message.data.startDateTime);
            const endDate = new Date(startDate.getTime() + message.data.duration * 60000);

            const meeting = {
                id: this.generateMeetingId(),
                title: message.data.title.trim(),
                description: message.data.description || '',
                organizerId: message.data.organizerId,
                startDateTime: startDate.toISOString(),
                endDateTime: endDate.toISOString(),
                duration: message.data.duration,
                meetingType: message.data.meetingType,
                maxParticipants: message.data.maxParticipants,
                status: 'scheduled',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };

            this.meetings.push(meeting);
            await this.saveMeetings();

            console.log('[MeetingServer] Réunion créée:', meeting.id);
            this.sendResponse(ws, message.requestId, true, meeting, null);

        } catch (error) {
            console.error('[MeetingServer] Erreur création réunion:', error.message);
            this.sendResponse(ws, message.requestId, false, null, error.message);
        }
    }

    /**
     * Gère la récupération des réunions
     * @param {WebSocket} ws - WebSocket du client
     * @param {string} clientId - Identifiant du client
     * @param {object} message - Message reçu
     */
    handleGetMeetings(ws, clientId, message) {
        try {
            console.log('[MeetingServer] Récupération des réunions pour', clientId);

            const userId = message.data?.userId;
            const filter = message.data?.filter || 'all'; // all, upcoming, ongoing, completed
            const now = new Date();

            let filteredMeetings = this.meetings;

            // Filtrer par utilisateur si spécifié
            if (userId) {
                filteredMeetings = filteredMeetings.filter(m => m.organizerId === userId);
            }

            // Filtrer par statut temporel
            if (filter === 'upcoming') {
                filteredMeetings = filteredMeetings.filter(m => 
                    m.status === 'scheduled' && new Date(m.startDateTime) > now
                );
            } else if (filter === 'ongoing') {
                filteredMeetings = filteredMeetings.filter(m => 
                    m.status === 'scheduled' && 
                    new Date(m.startDateTime) <= now && 
                    new Date(m.endDateTime) >= now
                );
            } else if (filter === 'completed') {
                filteredMeetings = filteredMeetings.filter(m => 
                    m.status === 'completed' || 
                    (m.status === 'scheduled' && new Date(m.endDateTime) < now)
                );
            }

            // Trier par date de début
            filteredMeetings.sort((a, b) => new Date(a.startDateTime) - new Date(b.startDateTime));

            this.sendResponse(ws, message.requestId, true, filteredMeetings, null);

        } catch (error) {
            console.error('[MeetingServer] Erreur récupération réunions:', error.message);
            this.sendResponse(ws, message.requestId, false, null, error.message);
        }
    }

    /**
     * Gère la récupération des détails d'une réunion
     * @param {WebSocket} ws - WebSocket du client
     * @param {string} clientId - Identifiant du client
     * @param {object} message - Message reçu
     */
    handleGetMeetingDetails(ws, clientId, message) {
        try {
            const meetingId = message.data?.meetingId;

            if (!meetingId) {
                this.sendResponse(ws, message.requestId, false, null, 'ID de réunion manquant');
                return;
            }

            const meeting = this.meetings.find(m => m.id === meetingId);

            if (!meeting) {
                this.sendResponse(ws, message.requestId, false, null, 'Réunion non trouvée');
                return;
            }

            this.sendResponse(ws, message.requestId, true, meeting, null);

        } catch (error) {
            console.error('[MeetingServer] Erreur récupération détails réunion:', error.message);
            this.sendResponse(ws, message.requestId, false, null, error.message);
        }
    }

    /**
     * Gère la modification d'une réunion
     * @param {WebSocket} ws - WebSocket du client
     * @param {string} clientId - Identifiant du client
     * @param {object} message - Message reçu
     */
    async handleUpdateMeeting(ws, clientId, message) {
        try {
            const meetingId = message.data?.meetingId;
            const requesterId = message.data?.requesterId;

            if (!meetingId || !requesterId) {
                this.sendResponse(ws, message.requestId, false, null, 'ID de réunion ou de demandeur manquant');
                return;
            }

            const meeting = this.meetings.find(m => m.id === meetingId);

            if (!meeting) {
                this.sendResponse(ws, message.requestId, false, null, 'Réunion non trouvée');
                return;
            }

            // Vérifier que le demandeur est l'organisateur
            // NOTE: Cette vérification basique sera améliorée avec un vrai système d'authentification
            if (meeting.organizerId !== requesterId) {
                console.warn(`[MeetingServer] Tentative de modification non autorisée par ${requesterId} sur ${meetingId}`);
                this.sendResponse(ws, message.requestId, false, null, 'Non autorisé: seul l\'organisateur peut modifier la réunion');
                return;
            }

            // Valider les nouvelles données
            const validation = this.validateMeetingData({
                ...meeting,
                ...message.data.updates
            });

            if (!validation.valid) {
                this.sendResponse(ws, message.requestId, false, null, validation.errors.join(', '));
                return;
            }

            // Appliquer les mises à jour
            const updates = message.data.updates;
            if (updates.title) meeting.title = updates.title.trim();
            if (updates.description !== undefined) meeting.description = updates.description;
            if (updates.startDateTime) {
                const startDate = new Date(updates.startDateTime);
                meeting.startDateTime = startDate.toISOString();
                const newDuration = updates.duration || meeting.duration;
                meeting.endDateTime = new Date(startDate.getTime() + newDuration * 60000).toISOString();
            }
            if (updates.duration) {
                meeting.duration = updates.duration;
                const startDate = new Date(meeting.startDateTime);
                meeting.endDateTime = new Date(startDate.getTime() + updates.duration * 60000).toISOString();
            }
            if (updates.meetingType) meeting.meetingType = updates.meetingType;
            if (updates.maxParticipants) meeting.maxParticipants = updates.maxParticipants;

            meeting.updatedAt = new Date().toISOString();

            await this.saveMeetings();

            console.log('[MeetingServer] Réunion mise à jour:', meetingId);
            this.sendResponse(ws, message.requestId, true, meeting, null);

        } catch (error) {
            console.error('[MeetingServer] Erreur mise à jour réunion:', error.message);
            this.sendResponse(ws, message.requestId, false, null, error.message);
        }
    }

    /**
     * Gère l'annulation d'une réunion
     * @param {WebSocket} ws - WebSocket du client
     * @param {string} clientId - Identifiant du client
     * @param {object} message - Message reçu
     */
    async handleCancelMeeting(ws, clientId, message) {
        try {
            const meetingId = message.data?.meetingId;
            const requesterId = message.data?.requesterId;

            if (!meetingId || !requesterId) {
                this.sendResponse(ws, message.requestId, false, null, 'ID de réunion ou de demandeur manquant');
                return;
            }

            const meeting = this.meetings.find(m => m.id === meetingId);

            if (!meeting) {
                this.sendResponse(ws, message.requestId, false, null, 'Réunion non trouvée');
                return;
            }

            // Vérifier que le demandeur est l'organisateur
            // NOTE: Cette vérification basique sera améliorée avec un vrai système d'authentification
            if (meeting.organizerId !== requesterId) {
                console.warn(`[MeetingServer] Tentative d'annulation non autorisée par ${requesterId} sur ${meetingId}`);
                this.sendResponse(ws, message.requestId, false, null, 'Non autorisé: seul l\'organisateur peut annuler la réunion');
                return;
            }

            if (meeting.status === 'cancelled') {
                this.sendResponse(ws, message.requestId, false, null, 'La réunion est déjà annulée');
                return;
            }

            meeting.status = 'cancelled';
            meeting.updatedAt = new Date().toISOString();

            await this.saveMeetings();

            console.log('[MeetingServer] Réunion annulée:', meetingId);
            this.sendResponse(ws, message.requestId, true, meeting, null);

        } catch (error) {
            console.error('[MeetingServer] Erreur annulation réunion:', error.message);
            this.sendResponse(ws, message.requestId, false, null, error.message);
        }
    }

    /**
     * Envoie une réponse structurée au client
     * @param {WebSocket} ws - WebSocket du client
     * @param {string} requestId - ID de la requête
     * @param {boolean} success - Succès de l'opération
     * @param {object} data - Données de réponse
     * @param {string} error - Message d'erreur
     */
    sendResponse(ws, requestId, success, data, error) {
        this.sendToClient(ws, {
            type: 'response',
            requestId: requestId,
            success: success,
            data: data,
            error: error
        });
    }

    /**
     * Arrête le serveur WebSocket
     */
    stop() {
        if (this.wss) {
            console.log('[MeetingServer] Arrêt du serveur...');
            this.wss.close(() => {
                console.log('[MeetingServer] Serveur arrêté');
            });
        }
    }
}

// Point d'entrée principal si exécuté directement
if (require.main === module) {
    const server = new MeetingServer();
    server.start();

    // Gestion de l'arrêt propre
    process.on('SIGINT', () => {
        console.log('\n[MeetingServer] Signal SIGINT reçu');
        server.stop();
        process.exit(0);
    });

    process.on('SIGTERM', () => {
        console.log('\n[MeetingServer] Signal SIGTERM reçu');
        server.stop();
        process.exit(0);
    });
}

module.exports = MeetingServer;
