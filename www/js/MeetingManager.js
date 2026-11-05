/**
 * MeetingManager.js
 * Classe principale côté client Cordova pour MeetingProject
 * Gère la communication WebSocket avec le serveur
 */

class MeetingManager {
    constructor() {
        this.ws = null;
        this.serverUrl = null;
        this.clientId = null;
        this.isConnected = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 3000; // 3 secondes
        this.messageHandlers = new Map();
        this.pendingRequests = new Map(); // Stocke les requêtes en attente
        this.eventHandlers = new Map(); // Stocke les événements
        this.requestCounter = 0; // Compteur pour les IDs de requête
    }

    /**
     * Initialise le MeetingManager et se connecte au serveur WebSocket
     * @param {string} serverUrl - URL du serveur WebSocket (ex: ws://192.168.1.189:8080)
     */
    async initialize(serverUrl = 'ws://192.168.1.189:8080') {
        try {
            console.log('[MeetingManager] Initialisation avec serveur:', serverUrl);
            this.serverUrl = serverUrl;
            
            await this.connect();
            
            console.log('[MeetingManager] Initialisation terminée avec succès');
            return true;
        } catch (error) {
            console.error('[MeetingManager] Erreur lors de l\'initialisation:', error.message);
            throw error;
        }
    }

    /**
     * Établit la connexion WebSocket avec le serveur
     */
    connect() {
        return new Promise((resolve, reject) => {
            try {
                console.log('[MeetingManager] Connexion à', this.serverUrl);
                
                this.ws = new WebSocket(this.serverUrl);

                // Gestion de l'ouverture de la connexion
                this.ws.onopen = () => {
                    console.log('[MeetingManager] Connexion WebSocket établie');
                    this.isConnected = true;
                    this.reconnectAttempts = 0;
                    resolve();
                };

                // Gestion des messages reçus
                this.ws.onmessage = (event) => {
                    this.handleMessage(event.data);
                };

                // Gestion des erreurs
                this.ws.onerror = (error) => {
                    console.error('[MeetingManager] Erreur WebSocket:', error);
                    if (!this.isConnected) {
                        reject(new Error('Échec de la connexion WebSocket'));
                    }
                };

                // Gestion de la fermeture de la connexion
                this.ws.onclose = (event) => {
                    console.log('[MeetingManager] Connexion fermée:', event.code, event.reason);
                    this.isConnected = false;
                    this.ws = null;
                    
                    // Tentative de reconnexion automatique
                    if (this.reconnectAttempts < this.maxReconnectAttempts) {
                        this.reconnectAttempts++;
                        console.log(`[MeetingManager] Tentative de reconnexion ${this.reconnectAttempts}/${this.maxReconnectAttempts} dans ${this.reconnectDelay}ms`);
                        setTimeout(() => {
                            this.connect().catch(err => {
                                console.error('[MeetingManager] Échec de la reconnexion:', err.message);
                            });
                        }, this.reconnectDelay);
                    } else {
                        console.error('[MeetingManager] Nombre maximal de tentatives de reconnexion atteint');
                    }
                };

                // Timeout de connexion
                setTimeout(() => {
                    if (!this.isConnected) {
                        this.ws.close();
                        reject(new Error('Timeout de connexion WebSocket'));
                    }
                }, 10000); // 10 secondes

            } catch (error) {
                console.error('[MeetingManager] Erreur lors de la connexion:', error.message);
                reject(error);
            }
        });
    }

    /**
     * Gère les messages reçus du serveur
     * @param {string} data - Données reçues
     */
    handleMessage(data) {
        try {
            const message = JSON.parse(data);
            console.log('[MeetingManager] Message reçu:', message.type);

            // Stocker l'ID client si fourni
            if (message.type === 'connection' && message.clientId) {
                this.clientId = message.clientId;
                console.log('[MeetingManager] ID client reçu:', this.clientId);
            }

            // Gérer les réponses aux requêtes
            if (message.type === 'response' && message.requestId) {
                this.handleResponse(message);
                return;
            }

            // Appeler le handler correspondant si enregistré
            const handler = this.messageHandlers.get(message.type);
            if (handler) {
                handler(message);
            }

        } catch (error) {
            console.error('[MeetingManager] Erreur parsing message:', error.message);
        }
    }

    /**
     * Gère les réponses du serveur
     * @param {object} message - Message de réponse
     */
    handleResponse(message) {
        const pending = this.pendingRequests.get(message.requestId);
        if (pending) {
            if (message.success) {
                if (pending.resolve) {
                    pending.resolve(message.data);
                }
            } else {
                if (pending.reject) {
                    pending.reject(new Error(message.error || 'Erreur inconnue'));
                }
            }
            this.pendingRequests.delete(message.requestId);
        }
    }

    /**
     * Envoie un message au serveur
     * @param {object} message - Message à envoyer
     */
    send(message) {
        if (!this.isConnected || !this.ws) {
            console.error('[MeetingManager] Impossible d\'envoyer: non connecté');
            return false;
        }

        try {
            this.ws.send(JSON.stringify(message));
            console.log('[MeetingManager] Message envoyé:', message.type);
            return true;
        } catch (error) {
            console.error('[MeetingManager] Erreur envoi message:', error.message);
            return false;
        }
    }

    /**
     * Enregistre un handler pour un type de message
     * @param {string} messageType - Type de message
     * @param {function} handler - Fonction de gestion
     */
    on(messageType, handler) {
        this.messageHandlers.set(messageType, handler);
        console.log('[MeetingManager] Handler enregistré pour:', messageType);
    }

    /**
     * Teste la connexion en envoyant un ping
     */
    ping() {
        return this.send({
            type: 'ping',
            timestamp: new Date().toISOString()
        });
    }

    /**
     * Déconnecte proprement du serveur
     */
    disconnect() {
        if (this.ws) {
            console.log('[MeetingManager] Déconnexion...');
            this.reconnectAttempts = this.maxReconnectAttempts; // Empêche la reconnexion
            this.ws.close();
            this.ws = null;
            this.isConnected = false;
            this.clientId = null;
        }
    }

    /**
     * Retourne l'état de connexion
     * @returns {boolean} État de connexion
     */
    getConnectionStatus() {
        return this.isConnected;
    }

    /**
     * Retourne l'ID client si connecté
     * @returns {string|null} ID client
     */
    getClientId() {
        return this.clientId;
    }

    // ==================== MODULE 2: GESTION DES RÉUNIONS ====================

    /**
     * Génère un ID de requête unique
     * @returns {string} ID de requête
     */
    generateRequestId() {
        this.requestCounter++;
        return 'req_' + Date.now() + '_' + this.requestCounter;
    }

    /**
     * Envoie une requête et attend la réponse
     * @param {string} type - Type de message
     * @param {object} data - Données de la requête
     * @param {number} timeout - Timeout en ms (défaut 10000)
     * @returns {Promise} Promise avec les données de réponse
     */
    sendRequest(type, data, timeout = 10000) {
        return new Promise((resolve, reject) => {
            const requestId = this.generateRequestId();

            // Enregistrer la requête en attente
            this.pendingRequests.set(requestId, {
                resolve: resolve,
                reject: reject,
                timestamp: Date.now()
            });

            // Envoyer la requête
            const success = this.send({
                type: type,
                requestId: requestId,
                data: data
            });

            if (!success) {
                this.pendingRequests.delete(requestId);
                reject(new Error('Échec de l\'envoi de la requête'));
                return;
            }

            // Timeout
            setTimeout(() => {
                if (this.pendingRequests.has(requestId)) {
                    this.pendingRequests.delete(requestId);
                    reject(new Error('Timeout de la requête'));
                }
            }, timeout);
        });
    }

    /**
     * Enregistre un handler d'événement
     * @param {string} eventType - Type d'événement
     * @param {function} handler - Fonction de gestion
     */
    onEvent(eventType, handler) {
        if (!this.eventHandlers.has(eventType)) {
            this.eventHandlers.set(eventType, []);
        }
        this.eventHandlers.get(eventType).push(handler);
        console.log('[MeetingManager] Event handler enregistré pour:', eventType);
    }

    /**
     * Déclenche un événement
     * @param {string} eventType - Type d'événement
     * @param {object} data - Données de l'événement
     */
    emitEvent(eventType, data) {
        const handlers = this.eventHandlers.get(eventType);
        if (handlers) {
            handlers.forEach(handler => {
                try {
                    handler(data);
                } catch (error) {
                    console.error('[MeetingManager] Erreur handler événement:', error.message);
                }
            });
        }
    }

    /**
     * Crée une nouvelle réunion
     * @param {object} meetingData - Données de la réunion
     * @returns {Promise} Promise avec la réunion créée
     */
    async createMeeting(meetingData) {
        try {
            console.log('[MeetingManager] Création de réunion:', meetingData.title);

            // Validation côté client
            if (!meetingData.title || meetingData.title.trim().length === 0) {
                throw new Error('Le titre est obligatoire');
            }

            if (!meetingData.startDateTime) {
                throw new Error('La date de début est obligatoire');
            }

            if (!meetingData.duration || meetingData.duration <= 0) {
                throw new Error('La durée doit être positive');
            }

            if (!meetingData.meetingType || !['audio', 'video'].includes(meetingData.meetingType)) {
                throw new Error('Le type de réunion doit être "audio" ou "video"');
            }

            if (!meetingData.maxParticipants || meetingData.maxParticipants <= 0) {
                throw new Error('Le nombre maximum de participants doit être positif');
            }

            // NOTE: organizerId devrait venir d'un système d'authentification
            // Pour l'instant, on utilise le clientId
            const dataToSend = {
                ...meetingData,
                organizerId: meetingData.organizerId || this.clientId
            };

            const meeting = await this.sendRequest('CREATE_MEETING', dataToSend);
            
            this.emitEvent('meetingCreated', meeting);
            return meeting;

        } catch (error) {
            console.error('[MeetingManager] Erreur création réunion:', error.message);
            this.emitEvent('meetingError', { action: 'create', error: error.message });
            throw error;
        }
    }

    /**
     * Récupère les réunions de l'utilisateur
     * @param {string} userId - ID de l'utilisateur
     * @param {string} filter - Filtre: all, upcoming, ongoing, completed
     * @returns {Promise} Promise avec la liste des réunions
     */
    async getMeetings(userId = null, filter = 'all') {
        try {
            console.log('[MeetingManager] Récupération des réunions, filtre:', filter);

            const meetings = await this.sendRequest('GET_MEETINGS', {
                userId: userId,
                filter: filter
            });

            this.emitEvent('meetingsLoaded', meetings);
            return meetings;

        } catch (error) {
            console.error('[MeetingManager] Erreur récupération réunions:', error.message);
            this.emitEvent('meetingError', { action: 'getMeetings', error: error.message });
            throw error;
        }
    }

    /**
     * Récupère les détails d'une réunion
     * @param {string} meetingId - ID de la réunion
     * @returns {Promise} Promise avec les détails de la réunion
     */
    async getMeetingDetails(meetingId) {
        try {
            console.log('[MeetingManager] Récupération détails réunion:', meetingId);

            const meeting = await this.sendRequest('GET_MEETING_DETAILS', {
                meetingId: meetingId
            });

            return meeting;

        } catch (error) {
            console.error('[MeetingManager] Erreur récupération détails réunion:', error.message);
            this.emitEvent('meetingError', { action: 'getDetails', error: error.message });
            throw error;
        }
    }

    /**
     * Modifie une réunion existante
     * @param {string} meetingId - ID de la réunion
     * @param {object} updates - Modifications à appliquer
     * @returns {Promise} Promise avec la réunion mise à jour
     */
    async updateMeeting(meetingId, updates) {
        try {
            console.log('[MeetingManager] Modification réunion:', meetingId);

            // NOTE: requesterId devrait venir d'un système d'authentification
            const updatedMeeting = await this.sendRequest('UPDATE_MEETING', {
                meetingId: meetingId,
                requesterId: this.clientId,
                updates: updates
            });

            this.emitEvent('meetingUpdated', updatedMeeting);
            return updatedMeeting;

        } catch (error) {
            console.error('[MeetingManager] Erreur modification réunion:', error.message);
            this.emitEvent('meetingError', { action: 'update', error: error.message });
            throw error;
        }
    }

    /**
     * Annule une réunion
     * @param {string} meetingId - ID de la réunion
     * @returns {Promise} Promise avec la réunion annulée
     */
    async cancelMeeting(meetingId) {
        try {
            console.log('[MeetingManager] Annulation réunion:', meetingId);

            // NOTE: requesterId devrait venir d'un système d'authentification
            const cancelledMeeting = await this.sendRequest('CANCEL_MEETING', {
                meetingId: meetingId,
                requesterId: this.clientId
            });

            this.emitEvent('meetingCancelled', cancelledMeeting);
            return cancelledMeeting;

        } catch (error) {
            console.error('[MeetingManager] Erreur annulation réunion:', error.message);
            this.emitEvent('meetingError', { action: 'cancel', error: error.message });
            throw error;
        }
    }

    /**
     * Récupère les réunions à venir
     * @param {string} userId - ID de l'utilisateur
     * @returns {Promise} Promise avec la liste des réunions à venir
     */
    async getUpcomingMeetings(userId = null) {
        return this.getMeetings(userId, 'upcoming');
    }

    /**
     * Récupère les réunions en cours
     * @param {string} userId - ID de l'utilisateur
     * @returns {Promise} Promise avec la liste des réunions en cours
     */
    async getOngoingMeetings(userId = null) {
        return this.getMeetings(userId, 'ongoing');
    }

    /**
     * Récupère les réunions terminées
     * @param {string} userId - ID de l'utilisateur
     * @returns {Promise} Promise avec la liste des réunions terminées
     */
    async getCompletedMeetings(userId = null) {
        return this.getMeetings(userId, 'completed');
    }
}
