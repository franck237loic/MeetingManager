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
        this.participants = new Map(); // Stocke les participants par réunion (meetingId -> Map of participantId -> participant)
        this.clientToMeeting = new Map(); // Stocke le mapping clientId -> meetingId pour les participants actifs
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

            // === MODULE 4: GESTION DES PARTICIPANTS ===

            // Rejoindre une réunion
            if (message.type === 'JOIN_MEETING') {
                this.handleJoinMeeting(ws, clientId, message);
                return;
            }

            // Quitter une réunion
            if (message.type === 'LEAVE_MEETING') {
                this.handleLeaveMeeting(ws, clientId, message);
                return;
            }

            // Récupérer les participants
            if (message.type === 'GET_PARTICIPANTS') {
                this.handleGetParticipants(ws, clientId, message);
                return;
            }

            // === MODULE 5: SIGNALISATION WEBRTC ===

            // Offre WebRTC
            if (message.type === 'WEBRTC_OFFER') {
                this.handleWebRTCOffer(ws, clientId, message);
                return;
            }

            // Réponse WebRTC
            if (message.type === 'WEBRTC_ANSWER') {
                this.handleWebRTCAnswer(ws, clientId, message);
                return;
            }

            // ICE Candidate WebRTC
            if (message.type === 'WEBRTC_ICE_CANDIDATE') {
                this.handleWebRTCIceCandidate(ws, clientId, message);
                return;
            }

            // Renégociation WebRTC
            if (message.type === 'WEBRTC_RENEGOTIATION') {
                this.handleWebRTCRenegotiation(ws, clientId, message);
                return;
            }

            // Changement d'état média
            if (message.type === 'MEDIA_STATE_CHANGED') {
                this.handleMediaStateChanged(ws, clientId, message);
                return;
            }

            // Début partage d'écran
            if (message.type === 'SCREEN_SHARE_STARTED') {
                this.handleScreenShareStarted(ws, clientId, message);
                return;
            }

            // Arrêt partage d'écran
            if (message.type === 'SCREEN_SHARE_STOPPED') {
                this.handleScreenShareStopped(ws, clientId, message);
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
        
        // Nettoyer le participant si présent dans une réunion
        this.cleanupParticipant(clientId);
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
     * Génère un code de réunion facile à communiquer
     * Format: XXX-XXX (3 chiffres, tiret, 3 chiffres)
     * @returns {string} Code de réunion
     */
    generateMeetingCode() {
        const part1 = Math.floor(100 + Math.random() * 900);
        const part2 = Math.floor(100 + Math.random() * 900);
        return `${part1}-${part2}`;
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
                code: this.generateMeetingCode(),
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

            console.log('[MeetingServer] Réunion créée:', meeting.id, 'Code:', meeting.code);
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

    // ==================== MODULE 4: GESTION DES PARTICIPANTS ====================

    /**
     * Gère la demande de rejoindre une réunion
     * @param {WebSocket} ws - WebSocket du client
     * @param {string} clientId - Identifiant du client
     * @param {object} message - Message reçu
     */
    async handleJoinMeeting(ws, clientId, message) {
        try {
            const meetingCode = message.data?.code;
            const meetingId = message.data?.meetingId;
            const participantName = message.data?.participantName || 'Participant';

            console.log('[MeetingServer] Demande de rejoindre réunion par', clientId);

            let meeting = null;

            // Recherche par code ou par ID
            if (meetingCode) {
                meeting = this.meetings.find(m => m.code === meetingCode);
            } else if (meetingId) {
                meeting = this.meetings.find(m => m.id === meetingId);
            }

            if (!meeting) {
                this.sendResponse(ws, message.requestId, false, null, 'Réunion non trouvée');
                return;
            }

            // Vérifier le statut
            if (meeting.status === 'cancelled') {
                this.sendResponse(ws, message.requestId, false, null, 'Cette réunion a été annulée');
                return;
            }

            if (meeting.status === 'completed') {
                this.sendResponse(ws, message.requestId, false, null, 'Cette réunion est terminée');
                return;
            }

            // Vérifier si le client est déjà dans une réunion
            if (this.clientToMeeting.has(clientId)) {
                const currentMeetingId = this.clientToMeeting.get(clientId);
                if (currentMeetingId !== meeting.id) {
                    this.sendResponse(ws, message.requestId, false, null, 'Vous êtes déjà dans une autre réunion');
                    return;
                }
            }

            // Vérifier la limite de participants
            const meetingParticipants = this.participants.get(meeting.id) || new Map();
            if (meetingParticipants.size >= meeting.maxParticipants) {
                this.sendResponse(ws, message.requestId, false, null, 'La réunion est complète');
                return;
            }

            // Créer ou mettre à jour la liste des participants de cette réunion
            if (!this.participants.has(meeting.id)) {
                this.participants.set(meeting.id, new Map());
            }

            const participantId = 'part_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            const participant = {
                id: participantId,
                clientId: clientId,
                name: participantName,
                joinedAt: new Date().toISOString(),
                isOrganizer: meeting.organizerId === clientId
            };

            this.participants.get(meeting.id).set(participantId, participant);
            this.clientToMeeting.set(clientId, meeting.id);

            console.log('[MeetingServer] Participant rejoint:', participantId, 'dans réunion', meeting.id);

            // Notifier les autres participants
            this.notifyParticipants(meeting.id, {
                type: 'PARTICIPANT_JOINED',
                participant: participant
            }, participantId);

            // Répondre au client
            this.sendResponse(ws, message.requestId, true, {
                meeting: meeting,
                participant: participant,
                participantsCount: this.participants.get(meeting.id).size
            }, null);

        } catch (error) {
            console.error('[MeetingServer] Erreur rejoindre réunion:', error.message);
            this.sendResponse(ws, message.requestId, false, null, error.message);
        }
    }

    /**
     * Gère la demande de quitter une réunion
     * @param {WebSocket} ws - WebSocket du client
     * @param {string} clientId - Identifiant du client
     * @param {object} message - Message reçu
     */
    async handleLeaveMeeting(ws, clientId, message) {
        try {
            const meetingId = message.data?.meetingId;

            console.log('[MeetingServer] Demande de quitter réunion par', clientId);

            // Vérifier si le client est dans une réunion
            const currentMeetingId = this.clientToMeeting.get(clientId);
            if (!currentMeetingId) {
                this.sendResponse(ws, message.requestId, false, null, 'Vous n\'êtes dans aucune réunion');
                return;
            }

            // Si meetingId est spécifié, vérifier qu'il correspond
            if (meetingId && meetingId !== currentMeetingId) {
                this.sendResponse(ws, message.requestId, false, null, 'ID de réunion incorrect');
                return;
            }

            const actualMeetingId = meetingId || currentMeetingId;
            const meetingParticipants = this.participants.get(actualMeetingId);

            if (!meetingParticipants) {
                this.sendResponse(ws, message.requestId, false, null, 'Réunion non trouvée');
                return;
            }

            // Trouver le participant
            let participantId = null;
            for (const [pid, participant] of meetingParticipants) {
                if (participant.clientId === clientId) {
                    participantId = pid;
                    break;
                }
            }

            if (!participantId) {
                this.sendResponse(ws, message.requestId, false, null, 'Participant non trouvé');
                return;
            }

            const participant = meetingParticipants.get(participantId);

            // Retirer le participant
            meetingParticipants.delete(participantId);
            this.clientToMeeting.delete(clientId);

            // Nettoyer si la réunion est vide
            if (meetingParticipants.size === 0) {
                this.participants.delete(actualMeetingId);
            }

            console.log('[MeetingServer] Parti quitte:', participantId, 'de réunion', actualMeetingId);

            // Notifier les autres participants
            this.notifyParticipants(actualMeetingId, {
                type: 'PARTICIPANT_LEFT',
                participantId: participantId
            }, participantId);

            // Répondre au client
            this.sendResponse(ws, message.requestId, true, { left: true }, null);

        } catch (error) {
            console.error('[MeetingServer] Erreur quitter réunion:', error.message);
            this.sendResponse(ws, message.requestId, false, null, error.message);
        }
    }

    /**
     * Gère la demande de récupération des participants
     * @param {WebSocket} ws - WebSocket du client
     * @param {string} clientId - Identifiant du client
     * @param {object} message - Message reçu
     */
    handleGetParticipants(ws, clientId, message) {
        try {
            const meetingId = message.data?.meetingId;

            if (!meetingId) {
                this.sendResponse(ws, message.requestId, false, null, 'ID de réunion manquant');
                return;
            }

            const meetingParticipants = this.participants.get(meetingId);
            if (!meetingParticipants) {
                this.sendResponse(ws, message.requestId, true, [], null);
                return;
            }

            const participantsList = Array.from(meetingParticipants.values());
            this.sendResponse(ws, message.requestId, true, participantsList, null);

        } catch (error) {
            console.error('[MeetingServer] Erreur récupération participants:', error.message);
            this.sendResponse(ws, message.requestId, false, null, error.message);
        }
    }

    /**
     * Notifie tous les participants d'une réunion
     * @param {string} meetingId - ID de la réunion
     * @param {object} notification - Notification à envoyer
     * @param {string} excludeParticipantId - ID du participant à exclure
     */
    notifyParticipants(meetingId, notification, excludeParticipantId = null) {
        const meetingParticipants = this.participants.get(meetingId);
        if (!meetingParticipants) return;

        meetingParticipants.forEach((participant) => {
            if (participant.id !== excludeParticipantId) {
                const client = this.clients.get(participant.clientId);
                if (client && client.ws && client.ws.readyState === WebSocket.OPEN) {
                    this.sendToClient(client.ws, notification);
                }
            }
        });
    }

    /**
     * Nettoie un participant lors de la déconnexion
     * @param {string} clientId - ID du client
     */
    cleanupParticipant(clientId) {
        const meetingId = this.clientToMeeting.get(clientId);
        if (!meetingId) return;

        const meetingParticipants = this.participants.get(meetingId);
        if (!meetingParticipants) return;

        // Trouver et retirer le participant
        let participantId = null;
        for (const [pid, participant] of meetingParticipants) {
            if (participant.clientId === clientId) {
                participantId = pid;
                break;
            }
        }

        if (participantId) {
            const participant = meetingParticipants.get(participantId);
            meetingParticipants.delete(participantId);
            this.clientToMeeting.delete(clientId);

            // Nettoyer si vide
            if (meetingParticipants.size === 0) {
                this.participants.delete(meetingId);
            }

            console.log('[MeetingServer] Participant nettoyé:', participantId);

            // Notifier les autres
            this.notifyParticipants(meetingId, {
                type: 'PARTICIPANT_LEFT',
                participantId: participantId
            }, participantId);
        }
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

    // ==================== MODULE 5: SIGNALISATION WEBRTC ====================

    /**
     * Vérifie qu'un client appartient à une réunion
     * @param {string} clientId - ID du client
     * @param {string} meetingId - ID de la réunion
     * @returns {boolean} Vrai si le client est dans la réunion
     */
    isClientInMeeting(clientId, meetingId) {
        const clientMeetingId = this.clientToMeeting.get(clientId);
        return clientMeetingId === meetingId;
    }

    /**
     * Gère une offre WebRTC
     * @param {WebSocket} ws - WebSocket du client
     * @param {string} clientId - ID du client
     * @param {object} message - Message reçu
     */
    handleWebRTCOffer(ws, clientId, message) {
        try {
            const { meetingId, fromParticipantId, toParticipantId, offer } = message;

            console.log('[MeetingServer] Offre WebRTC de', fromParticipantId, 'vers', toParticipantId);

            // Vérifier que l'expéditeur est dans la réunion
            if (!this.isClientInMeeting(clientId, meetingId)) {
                console.warn('[MeetingServer] Offre WebRTC refusée: client pas dans la réunion');
                return;
            }

            // Trouver le destinataire
            const meetingParticipants = this.participants.get(meetingId);
            if (!meetingParticipants) {
                console.warn('[MeetingServer] Réunion non trouvée:', meetingId);
                return;
            }

            const toParticipant = meetingParticipants.get(toParticipantId);
            if (!toParticipant) {
                console.warn('[MeetingServer] Destinataire non trouvé:', toParticipantId);
                return;
            }

            // Relayer l'offre au destinataire
            const toClient = this.clients.get(toParticipant.clientId);
            if (toClient && toClient.ws && toClient.ws.readyState === WebSocket.OPEN) {
                this.sendToClient(toClient.ws, {
                    type: 'WEBRTC_OFFER',
                    meetingId: meetingId,
                    fromParticipantId: fromParticipantId,
                    toParticipantId: toParticipantId,
                    offer: offer
                });
                console.log('[MeetingServer] Offre relayée à', toParticipantId);
            }

        } catch (error) {
            console.error('[MeetingServer] Erreur traitement offre WebRTC:', error.message);
        }
    }

    /**
     * Gère une réponse WebRTC
     * @param {WebSocket} ws - WebSocket du client
     * @param {string} clientId - ID du client
     * @param {object} message - Message reçu
     */
    handleWebRTCAnswer(ws, clientId, message) {
        try {
            const { meetingId, fromParticipantId, toParticipantId, answer } = message;

            console.log('[MeetingServer] Réponse WebRTC de', fromParticipantId, 'vers', toParticipantId);

            // Vérifier que l'expéditeur est dans la réunion
            if (!this.isClientInMeeting(clientId, meetingId)) {
                console.warn('[MeetingServer] Réponse WebRTC refusée: client pas dans la réunion');
                return;
            }

            // Trouver le destinataire
            const meetingParticipants = this.participants.get(meetingId);
            if (!meetingParticipants) {
                console.warn('[MeetingServer] Réunion non trouvée:', meetingId);
                return;
            }

            const toParticipant = meetingParticipants.get(toParticipantId);
            if (!toParticipant) {
                console.warn('[MeetingServer] Destinataire non trouvé:', toParticipantId);
                return;
            }

            // Relayer la réponse au destinataire
            const toClient = this.clients.get(toParticipant.clientId);
            if (toClient && toClient.ws && toClient.ws.readyState === WebSocket.OPEN) {
                this.sendToClient(toClient.ws, {
                    type: 'WEBRTC_ANSWER',
                    meetingId: meetingId,
                    fromParticipantId: fromParticipantId,
                    toParticipantId: toParticipantId,
                    answer: answer
                });
                console.log('[MeetingServer] Réponse relayée à', toParticipantId);
            }

        } catch (error) {
            console.error('[MeetingServer] Erreur traitement réponse WebRTC:', error.message);
        }
    }

    /**
     * Gère un ICE candidate WebRTC
     * @param {WebSocket} ws - WebSocket du client
     * @param {string} clientId - ID du client
     * @param {object} message - Message reçu
     */
    handleWebRTCIceCandidate(ws, clientId, message) {
        try {
            const { meetingId, fromParticipantId, toParticipantId, candidate } = message;

            console.log('[MeetingServer] ICE candidate de', fromParticipantId, 'vers', toParticipantId);

            // Vérifier que l'expéditeur est dans la réunion
            if (!this.isClientInMeeting(clientId, meetingId)) {
                console.warn('[MeetingServer] ICE candidate refusée: client pas dans la réunion');
                return;
            }

            // Trouver le destinataire
            const meetingParticipants = this.participants.get(meetingId);
            if (!meetingParticipants) {
                console.warn('[MeetingServer] Réunion non trouvée:', meetingId);
                return;
            }

            const toParticipant = meetingParticipants.get(toParticipantId);
            if (!toParticipant) {
                console.warn('[MeetingServer] Destinataire non trouvé:', toParticipantId);
                return;
            }

            // Relayer l'ICE candidate au destinataire
            const toClient = this.clients.get(toParticipant.clientId);
            if (toClient && toClient.ws && toClient.ws.readyState === WebSocket.OPEN) {
                this.sendToClient(toClient.ws, {
                    type: 'WEBRTC_ICE_CANDIDATE',
                    meetingId: meetingId,
                    fromParticipantId: fromParticipantId,
                    toParticipantId: toParticipantId,
                    candidate: candidate
                });
                console.log('[MeetingServer] ICE candidate relayée à', toParticipantId);
            }

        } catch (error) {
            console.error('[MeetingServer] Erreur traitement ICE candidate:', error.message);
        }
    }

    /**
     * Gère une renégociation WebRTC
     * @param {WebSocket} ws - WebSocket du client
     * @param {string} clientId - ID du client
     * @param {object} message - Message reçu
     */
    handleWebRTCRenegotiation(ws, clientId, message) {
        try {
            const { meetingId, fromParticipantId, toParticipantId, offer } = message;

            console.log('[MeetingServer] Renégociation WebRTC de', fromParticipantId, 'vers', toParticipantId);

            // Vérifier que l'expéditeur est dans la réunion
            if (!this.isClientInMeeting(clientId, meetingId)) {
                console.warn('[MeetingServer] Renégociation refusée: client pas dans la réunion');
                return;
            }

            // Trouver le destinataire
            const meetingParticipants = this.participants.get(meetingId);
            if (!meetingParticipants) {
                console.warn('[MeetingServer] Réunion non trouvée:', meetingId);
                return;
            }

            const toParticipant = meetingParticipants.get(toParticipantId);
            if (!toParticipant) {
                console.warn('[MeetingServer] Destinataire non trouvé:', toParticipantId);
                return;
            }

            // Relayer l'offre de renégociation au destinataire
            const toClient = this.clients.get(toParticipant.clientId);
            if (toClient && toClient.ws && toClient.ws.readyState === WebSocket.OPEN) {
                this.sendToClient(toClient.ws, {
                    type: 'WEBRTC_OFFER', // Réutiliser le même type pour la renégociation
                    meetingId: meetingId,
                    fromParticipantId: fromParticipantId,
                    toParticipantId: toParticipantId,
                    offer: offer,
                    renegotiation: true
                });
                console.log('[MeetingServer] Renégociation relayée à', toParticipantId);
            }

        } catch (error) {
            console.error('[MeetingServer] Erreur traitement renégociation:', error.message);
        }
    }

    /**
     * Gère un changement d'état média
     * @param {WebSocket} ws - WebSocket du client
     * @param {string} clientId - ID du client
     * @param {object} message - Message reçu
     */
    handleMediaStateChanged(ws, clientId, message) {
        try {
            const { meetingId, participantId, state } = message;

            console.log('[MeetingServer] État média changé pour', participantId, state);

            // Vérifier que le client est dans la réunion
            if (!this.isClientInMeeting(clientId, meetingId)) {
                console.warn('[MeetingServer] Changement état refusé: client pas dans la réunion');
                return;
            }

            // Notifier tous les autres participants
            this.notifyParticipants(meetingId, {
                type: 'MEDIA_STATE_CHANGED',
                participantId: participantId,
                state: state
            }, participantId);

        } catch (error) {
            console.error('[MeetingServer] Erreur traitement changement état:', error.message);
        }
    }

    /**
     * Gère le début de partage d'écran
     * @param {WebSocket} ws - WebSocket du client
     * @param {string} clientId - ID du client
     * @param {object} message - Message reçu
     */
    handleScreenShareStarted(ws, clientId, message) {
        try {
            const { meetingId, participantId } = message;

            console.log('[MeetingServer] Partage d\'écran démarré par', participantId);

            // Vérifier que le client est dans la réunion
            if (!this.isClientInMeeting(clientId, meetingId)) {
                console.warn('[MeetingServer] Partage écran refusé: client pas dans la réunion');
                return;
            }

            // Notifier tous les autres participants
            this.notifyParticipants(meetingId, {
                type: 'SCREEN_SHARE_STARTED',
                participantId: participantId
            }, participantId);

        } catch (error) {
            console.error('[MeetingServer] Erreur traitement début partage écran:', error.message);
        }
    }

    /**
     * Gère l'arrêt de partage d'écran
     * @param {WebSocket} ws - WebSocket du client
     * @param {string} clientId - ID du client
     * @param {object} message - Message reçu
     */
    handleScreenShareStopped(ws, clientId, message) {
        try {
            const { meetingId, participantId } = message;

            console.log('[MeetingServer] Partage d\'écran arrêté par', participantId);

            // Vérifier que le client est dans la réunion
            if (!this.isClientInMeeting(clientId, meetingId)) {
                console.warn('[MeetingServer] Arrêt partage refusé: client pas dans la réunion');
                return;
            }

            // Notifier tous les autres participants
            this.notifyParticipants(meetingId, {
                type: 'SCREEN_SHARE_STOPPED',
                participantId: participantId
            }, participantId);

        } catch (error) {
            console.error('[MeetingServer] Erreur traitement arrêt partage écran:', error.message);
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
