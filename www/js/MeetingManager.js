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

        // ==================== MODULE 5: WEBRTC ====================
        this.peerConnections = new Map(); // participantId -> RTCPeerConnection
        this.localStream = null; // Flux média local
        this.screenStream = null; // Flux de partage d'écran
        this.screenCanvasStream = null; // Canvas stream pour plugin mobile
        this.screenSharePluginAvailable = false; // Plugin disponible ?
        this.mediaState = {
            audioEnabled: false,
            videoEnabled: false,
            screenSharing: false
        };
        this.iceServers = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' }
            ]
        };
        this.currentMeetingId = null;
        this.currentParticipantId = null;
        this.remoteStreams = new Map(); // participantId -> MediaStream
    }

    /**
     * Initialise le MeetingManager et se connecte au serveur WebSocket
     * @param {string} serverUrl - URL du serveur WebSocket (ex: wss://meeting-server-vrpf.onrender.com)
     */
    async initialize(serverUrl = 'wss://meeting-server-vrpf.onrender.com') {
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
            if (message.type === 'response') {
                this.handleResponse(message);
                return;
            }

            // ==================== MODULE 5: HANDLERS WEBRTC ====================
            // Handler pour les offres WebRTC
            if (message.type === 'WEBRTC_OFFER') {
                this.handleWebRTCOffer(message);
                return;
            }

            // Handler pour les réponses WebRTC
            if (message.type === 'WEBRTC_ANSWER') {
                this.handleWebRTCAnswer(message);
                return;
            }

            // Handler pour les ICE candidates
            if (message.type === 'WEBRTC_ICE_CANDIDATE') {
                this.handleWebRTCIceCandidate(message);
                return;
            }

            // Handler pour les changements d'état média
            if (message.type === 'MEDIA_STATE_CHANGED') {
                this.handleMediaStateChanged(message);
                return;
            }

            // Handler pour le début de partage d'écran
            if (message.type === 'SCREEN_SHARE_STARTED') {
                this.handleScreenShareStarted(message);
                return;
            }

            // Handler pour l'arrêt de partage d'écran
            if (message.type === 'SCREEN_SHARE_STOPPED') {
                this.handleScreenShareStopped(message);
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
     * Envoie une requête avec attente de réponse
     * @param {string} type - Type de requête
     * @param {object} data - Données de la requête
     * @returns {Promise} Promise avec la réponse
     */
    sendRequest(type, data = {}) {
        return new Promise((resolve, reject) => {
            if (!this.isConnected || !this.ws) {
                reject(new Error('Non connecté au serveur'));
                return;
            }

            const requestId = 'req_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

            // Stocker la callback
            this.pendingRequests.set(requestId, {
                resolve: resolve,
                reject: reject
            });

            // Envoyer la requête
            this.send({
                type: type,
                requestId: requestId,
                data: data
            });

            // Timeout après 30 secondes
            setTimeout(() => {
                if (this.pendingRequests.has(requestId)) {
                    this.pendingRequests.delete(requestId);
                    reject(new Error('Timeout de la requête'));
                }
            }, 30000);
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

    /**
     * Affiche un toast à l'utilisateur
     * @param {string} message - Message à afficher
     * @param {string} type - Type de toast (success, error, info)
     */
    showToast(message, type = 'info') {
        const toast = document.getElementById('toast');
        if (toast) {
            toast.textContent = message;
            toast.className = 'toast show ' + type;
            setTimeout(() => {
                toast.classList.remove('show');
            }, 3000);
        } else {
            console.log('[MeetingManager] Toast:', message);
        }
    }

    // ==================== MODULE 2: GESTION DES RÉUNIONS ====================

    /**
     * Normalise un code de réunion (format XXX-XXX-XXX)
     * @param {string} code - Code à normaliser
     * @returns {string} Code normalisé
     */
    normalizeMeetingCode(code) {
        if (!code && code !== 0) return "";
        const cleaned = String(code).trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
        if (!cleaned) return "";
        if (cleaned.length === 9) {
            return `${cleaned.slice(0, 3)}-${cleaned.slice(3, 6)}-${cleaned.slice(6, 9)}`;
        }
        if (cleaned.length === 11) {
            return cleaned.replace(/(.{3})(?=.)/g, "$1-");
        }
        return cleaned;
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

            const result = await this.sendRequest('CREATE_MEETING', {
                ...meetingData,
                organizerId: this.clientId
            });

            this.showToast('Réunion créée avec succès', 'success');
            return result;

        } catch (error) {
            console.error('[MeetingManager] Erreur création réunion:', error.message);
            this.showToast('Erreur lors de la création', 'error');
            throw error;
        }
    }

    /**
     * Rejoint une réunion par code (signalisation app_appel)
     * @param {string} code - Code de la réunion
     * @returns {Promise} Promise avec les détails de la réunion
     */
    async joinMeeting(code) {
        try {
            console.log('[MeetingManager] Rejoindre réunion:', code);

            const normalizedCode = this.normalizeMeetingCode(code);
            if (!normalizedCode) {
                this.showToast('Code requis');
                throw new Error('Code requis');
            }

            const result = await this.sendRequest('JOIN_MEETING', {
                code: normalizedCode,
                participantName: 'Participant'
            });

            this.showToast('Réunion jointe', 'success');
            return result;

        } catch (error) {
            console.error('[MeetingManager] Erreur rejoindre réunion:', error.message);
            this.showToast('Erreur lors de la jonction', 'error');
            throw error;
        }
    }

    /**
     * Annule une réunion (signalisation app_appel)
     * @param {string} meetingId - ID de la réunion
     * @returns {Promise} Promise avec la réunion annulée
     */
    async cancelMeeting(meetingId) {
        try {
            console.log('[MeetingManager] Annulation réunion:', meetingId);

            const result = await this.sendRequest('CANCEL_MEETING', {
                meetingId: meetingId,
                requesterId: this.clientId
            });

            this.showToast('Réunion annulée', 'success');
            return result;

        } catch (error) {
            console.error('[MeetingManager] Erreur annulation réunion:', error.message);
            this.showToast('Erreur lors de l\'annulation', 'error');
            throw error;
        }
    }

    /**
     * Force le démarrage d'une réunion (signalisation app_appel)
     * @param {string} code - Code de la réunion
     */
    startMeeting(code) {
        console.log('[MeetingManager] Démarrage forcé réunion:', code);

        const normalizedCode = this.normalizeMeetingCode(code);
        if (!normalizedCode) {
            this.showToast('Code requis');
            return;
        }

        this.send({
            type: 'meeting-force-start',
            code: normalizedCode,
        });

        console.log('[MeetingManager] Demande de démarrage forcé envoyée pour:', normalizedCode);
    }

    /**
     * Récupère les réunions via le serveur
     * @param {string} userId - ID de l'utilisateur
     * @param {string} filter - Filtre (all, upcoming, ongoing, completed)
     * @returns {Promise} Promise avec la liste des réunions
     */
    async getMeetings(userId, filter = 'all') {
        try {
            const result = await this.sendRequest('GET_MEETINGS', {
                userId: userId,
                filter: filter
            });
            return result;
        } catch (error) {
            console.error('[MeetingManager] Erreur récupération réunions:', error.message);
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
            const result = await this.sendRequest('GET_MEETING_DETAILS', {
                meetingId: meetingId
            });
            return result;
        } catch (error) {
            console.error('[MeetingManager] Erreur récupération détails réunion:', error.message);
            throw error;
        }
    }

    /**
     * Met à jour une réunion
     * @param {string} meetingId - ID de la réunion
     * @param {object} updates - Modifications à appliquer
     * @returns {Promise} Promise avec la réunion mise à jour
     */
    async updateMeeting(meetingId, updates) {
        try {
            const result = await this.sendRequest('UPDATE_MEETING', {
                meetingId: meetingId,
                requesterId: this.clientId,
                updates: updates
            });
            this.showToast('Réunion mise à jour', 'success');
            return result;
        } catch (error) {
            console.error('[MeetingManager] Erreur mise à jour réunion:', error.message);
            this.showToast('Erreur lors de la mise à jour', 'error');
            throw error;
        }
    }

    // ==================== MODULE 3: RENDU INTERFACE UTILISATEUR ====================

    /**
     * Met à jour l'indicateur de connexion dans l'interface
     * @param {boolean} connected - État de connexion
     */
    updateConnectionStatus(connected) {
        const statusElement = document.getElementById('connection-status');
        if (statusElement) {
            const indicator = statusElement.querySelector('.status-indicator');
            const text = statusElement.querySelector('.status-text');
            
            if (indicator && text) {
                indicator.classList.remove('connected', 'disconnected');
                if (connected) {
                    indicator.classList.add('connected');
                    text.textContent = 'Connecté';
                } else {
                    indicator.classList.add('disconnected');
                    text.textContent = 'Déconnecté';
                }
            }
        }
    }

    /**
     * Met à jour les statistiques du tableau de bord
     * @param {object} stats - Statistiques { scheduled, completed, cancelled }
     */
    updateStats(stats) {
        document.getElementById('stat-scheduled').textContent = stats.scheduled || 0;
        document.getElementById('stat-completed').textContent = stats.completed || 0;
        document.getElementById('stat-cancelled').textContent = stats.cancelled || 0;
    }

    /**
     * Affiche une liste de réunions dans un conteneur
     * @param {Array} meetings - Liste des réunions
     * @param {string} containerId - ID du conteneur
     */
    renderMeetingsList(meetings, containerId) {
        const container = document.getElementById(containerId);
        if (!container) return;

        if (!meetings || meetings.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon">📅</div>
                    <p>Aucune réunion trouvée</p>
                </div>
            `;
            return;
        }

        container.innerHTML = meetings.map(meeting => this.renderMeetingCard(meeting)).join('');
    }

    /**
     * Génère le HTML d'une carte de réunion
     * @param {object} meeting - Objet réunion
     * @returns {string} HTML de la carte
     */
    renderMeetingCard(meeting) {
        const startDate = new Date(meeting.startDateTime);
        const endDate = new Date(meeting.endDateTime);
        const formattedDate = startDate.toLocaleDateString('fr-FR', { 
            weekday: 'short', 
            day: 'numeric', 
            month: 'short' 
        });
        const formattedTime = startDate.toLocaleTimeString('fr-FR', { 
            hour: '2-digit', 
            minute: '2-digit' 
        });
        const duration = meeting.duration;

        const statusClass = meeting.status || 'scheduled';
        const statusText = this.getStatusText(meeting.status);

        const canEdit = meeting.status === 'scheduled';
        const canCancel = meeting.status === 'scheduled';
        const meetingCode = meeting.code || '';

        return `
            <div class="meeting-card" data-meeting-id="${meeting.id}">
                <div class="meeting-header">
                    <div>
                        <h3 class="meeting-title">${this.escapeHtml(meeting.title)}</h3>
                        ${meeting.description ? `<p class="meeting-description">${this.escapeHtml(meeting.description)}</p>` : ''}
                    </div>
                    <span class="meeting-status ${statusClass}">${statusText}</span>
                </div>
                <div class="meeting-meta">
                    <div class="meeting-meta-item">📅 ${formattedDate}</div>
                    <div class="meeting-meta-item">⏰ ${formattedTime}</div>
                    <div class="meeting-meta-item">⏱️ ${duration} min</div>
                    <div class="meeting-meta-item">👥 ${meeting.maxParticipants} participants</div>
                    <div class="meeting-meta-item">${meeting.meetingType === 'video' ? '🎥' : '🎤'} ${meeting.meetingType}</div>
                </div>
                <div class="meeting-actions">
                    <button class="btn btn-sm btn-secondary btn-view-details" data-meeting-id="${meeting.id}">
                        👁️ Détails
                    </button>
                    ${meetingCode ? `
                        <button class="btn btn-sm btn-secondary btn-show-code" data-meeting-id="${meeting.id}" data-meeting-code="${meetingCode}">
                            🔗 Code
                        </button>
                    ` : ''}
                    ${canEdit ? `
                        <button class="btn btn-sm btn-secondary btn-edit" data-meeting-id="${meeting.id}">
                            ✏️ Modifier
                        </button>
                    ` : ''}
                    ${canCancel ? `
                        <button class="btn btn-sm btn-danger btn-cancel" data-meeting-id="${meeting.id}">
                            ❌ Annuler
                        </button>
                    ` : ''}
                </div>
            </div>
        `;
    }

    /**
     * Retourne le texte du statut en français
     * @param {string} status - Statut de la réunion
     * @returns {string} Texte du statut
     */
    getStatusText(status) {
        const statusMap = {
            'scheduled': 'Programmée',
            'ongoing': 'En cours',
            'completed': 'Terminée',
            'cancelled': 'Annulée'
        };
        return statusMap[status] || status;
    }

    /**
     * Échappe les caractères HTML pour éviter les injections XSS
     * @param {string} text - Texte à échapper
     * @returns {string} Texte échappé
     */
    escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    /**
     * Affiche les détails d'une réunion dans le modal
     * @param {object} meeting - Objet réunion
     */
    showMeetingDetails(meeting) {
        const content = document.getElementById('meeting-details-content');
        if (!content) return;

        const startDate = new Date(meeting.startDateTime);
        const endDate = new Date(meeting.endDateTime);
        const formattedDate = startDate.toLocaleDateString('fr-FR', { 
            weekday: 'long', 
            day: 'numeric', 
            month: 'long', 
            year: 'numeric' 
        });
        const formattedTime = startDate.toLocaleTimeString('fr-FR', { 
            hour: '2-digit', 
            minute: '2-digit' 
        });

        content.innerHTML = `
            <div class="detail-row">
                <div class="detail-label">Titre:</div>
                <div class="detail-value">${this.escapeHtml(meeting.title)}</div>
            </div>
            <div class="detail-row">
                <div class="detail-label">Description:</div>
                <div class="detail-value">${this.escapeHtml(meeting.description || 'Non renseignée')}</div>
            </div>
            <div class="detail-row">
                <div class="detail-label">Date:</div>
                <div class="detail-value">${formattedDate}</div>
            </div>
            <div class="detail-row">
                <div class="detail-label">Heure:</div>
                <div class="detail-value">${formattedTime}</div>
            </div>
            <div class="detail-row">
                <div class="detail-label">Durée:</div>
                <div class="detail-value">${meeting.duration} minutes</div>
            </div>
            <div class="detail-row">
                <div class="detail-label">Type:</div>
                <div class="detail-value">${meeting.meetingType === 'video' ? 'Vidéo' : 'Audio'}</div>
            </div>
            <div class="detail-row">
                <div class="detail-label">Participants max:</div>
                <div class="detail-value">${meeting.maxParticipants}</div>
            </div>
            <div class="detail-row">
                <div class="detail-label">Statut:</div>
                <div class="detail-value">${this.getStatusText(meeting.status)}</div>
            </div>
            <div class="detail-row">
                <div class="detail-label">ID:</div>
                <div class="detail-value">${meeting.id}</div>
            </div>
        `;

        this.openModal('details-modal');
    }

    /**
     * Ouvre le modal de création/modification de réunion
     * @param {object} meeting - Réunion à modifier (null pour création)
     */
    openMeetingModal(meeting = null) {
        const modalTitle = document.getElementById('modal-title');
        const form = document.getElementById('meeting-form');
        const meetingIdInput = document.getElementById('meeting-id');

        if (meeting) {
            modalTitle.textContent = 'Modifier la réunion';
            meetingIdInput.value = meeting.id;
            document.getElementById('meeting-title').value = meeting.title;
            document.getElementById('meeting-description').value = meeting.description || '';
            
            const startDate = new Date(meeting.startDateTime);
            document.getElementById('meeting-date').value = startDate.toISOString().split('T')[0];
            document.getElementById('meeting-time').value = startDate.toTimeString().slice(0, 5);
            document.getElementById('meeting-duration').value = meeting.duration;
            document.getElementById('meeting-type').value = meeting.meetingType;
            document.getElementById('meeting-participants').value = meeting.maxParticipants;
        } else {
            modalTitle.textContent = 'Nouvelle réunion';
            meetingIdInput.value = '';
            form.reset();
            
            // Définir la date par défaut à demain
            const tomorrow = new Date();
            tomorrow.setDate(tomorrow.getDate() + 1);
            document.getElementById('meeting-date').value = tomorrow.toISOString().split('T')[0];
            document.getElementById('meeting-time').value = '09:00';
        }

        this.openModal('meeting-modal');
    }

    /**
     * Ouvre un modal
     * @param {string} modalId - ID du modal
     */
    openModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) {
            modal.classList.add('active');
        }
    }

    /**
     * Ferme tous les modals
     */
    closeAllModals() {
        document.querySelectorAll('.modal').forEach(modal => {
            modal.classList.remove('active');
        });
    }

    /**
     * Affiche un toast de notification
     * @param {string} message - Message à afficher
     * @param {string} type - Type (success, error)
     */
    showToast(message, type = 'success') {
        const toast = document.getElementById('toast');
        if (!toast) return;

        toast.textContent = message;
        toast.className = 'toast ' + type;
        toast.classList.add('show');

        setTimeout(() => {
            toast.classList.remove('show');
        }, 3000);
    }

    /**
     * Affiche une vue spécifique
     * @param {string} viewId - ID de la vue
     */
    showView(viewId) {
        // Masquer toutes les vues
        document.querySelectorAll('.view').forEach(view => {
            view.classList.remove('active');
        });

        // Afficher la vue demandée
        const view = document.getElementById('view-' + viewId);
        if (view) {
            view.classList.add('active');
        }

        // Mettre à jour le titre
        const titles = {
            'dashboard': 'Tableau de bord',
            'meetings': 'Mes réunions'
        };
        document.getElementById('page-title').textContent = titles[viewId] || viewId;

        // Mettre à jour la navigation
        document.querySelectorAll('.nav-item').forEach(item => {
            item.classList.remove('active');
            if (item.dataset.view === viewId) {
                item.classList.add('active');
            }
        });
    }

    /**
     * Charge les données pour le tableau de bord
     */
    async loadDashboard() {
        try {
            document.getElementById('recent-meetings').innerHTML = '<div class="loading">Chargement...</div>';

            const allMeetings = await this.getMeetings(this.clientId, 'all');
            
            // Calculer les statistiques
            const stats = {
                scheduled: allMeetings.filter(m => m.status === 'scheduled').length,
                completed: allMeetings.filter(m => m.status === 'completed').length,
                cancelled: allMeetings.filter(m => m.status === 'cancelled').length
            };

            this.updateStats(stats);

            // Afficher les 5 réunions les plus récentes
            const recentMeetings = allMeetings.slice(0, 5);
            this.renderMeetingsList(recentMeetings, 'recent-meetings');

        } catch (error) {
            console.error('[MeetingManager] Erreur chargement tableau de bord:', error);
            document.getElementById('recent-meetings').innerHTML = `
                <div class="empty-state">
                    <p>Erreur lors du chargement: ${error.message}</p>
                </div>
            `;
        }
    }

    /**
     * Charge les réunions avec un filtre
     * @param {string} filter - Filtre (all, upcoming, ongoing, completed)
     */
    async loadMeetingsWithFilter(filter = 'all') {
        try {
            document.getElementById('all-meetings').innerHTML = '<div class="loading">Chargement...</div>';

            const meetings = await this.getMeetings(this.clientId, filter);
            this.renderMeetingsList(meetings, 'all-meetings');

        } catch (error) {
            console.error('[MeetingManager] Erreur chargement réunions:', error);
            document.getElementById('all-meetings').innerHTML = `
                <div class="empty-state">
                    <p>Erreur lors du chargement: ${error.message}</p>
                </div>
            `;
        }
    }

    // ==================== MODULE 4: GESTION DES PARTICIPANTS ====================

    /**
     * Rejoint une réunion par code ou ID
     * @param {string} code - Code de la réunion (optionnel)
     * @param {string} meetingId - ID de la réunion (optionnel)
     * @param {string} participantName - Nom du participant
     * @returns {Promise} Promise avec les détails de la réunion et du participant
     */
    async joinMeeting(code = null, meetingId = null, participantName = 'Participant') {
        try {
            console.log('[MeetingManager] Rejoindre réunion:', code || meetingId);

            const result = await this.sendRequest('JOIN_MEETING', {
                code: code,
                meetingId: meetingId,
                participantName: participantName
            });

            this.currentMeetingId = result.meeting.id;
            this.currentParticipantId = result.participant.id;
            this.currentMeeting = result.meeting;
            this.currentParticipant = result.participant;

            this.emitEvent('meetingJoined', result);
            return result;

        } catch (error) {
            console.error('[MeetingManager] Erreur rejoindre réunion:', error.message);
            this.emitEvent('meetingError', { action: 'join', error: error.message });
            throw error;
        }
    }

    /**
     * Quitte la réunion actuelle
     * @returns {Promise} Promise de succès
     */
    async leaveMeeting() {
        try {
            if (!this.currentMeetingId) {
                throw new Error('Aucune réunion active');
            }

            console.log('[MeetingManager] Quitter réunion:', this.currentMeetingId);

            // Nettoyer WebRTC avant de quitter
            this.cleanupWebRTC();

            await this.sendRequest('LEAVE_MEETING', {
                meetingId: this.currentMeetingId
            });

            this.currentMeetingId = null;
            this.currentParticipantId = null;

            this.emitEvent('meetingLeft', {});
            return true;

        } catch (error) {
            console.error('[MeetingManager] Erreur quitter réunion:', error.message);
            this.emitEvent('meetingError', { action: 'leave', error: error.message });
            throw error;
        }
    }

    /**
     * Récupère la liste des participants de la réunion actuelle
     * @returns {Promise} Promise avec la liste des participants
     */
    async getParticipants() {
        try {
            if (!this.currentMeetingId) {
                throw new Error('Aucune réunion active');
            }

            const participants = await this.sendRequest('GET_PARTICIPANTS', {
                meetingId: this.currentMeetingId
            });

            return participants;

        } catch (error) {
            console.error('[MeetingManager] Erreur récupération participants:', error.message);
            this.emitEvent('meetingError', { action: 'getParticipants', error: error.message });
            throw error;
        }
    }

    /**
     * Génère le lien d'invitation pour une réunion
     * @param {string} meetingCode - Code de la réunion
     * @returns {string} Lien d'invitation
     */
    generateInvitationLink(meetingCode) {
        // Pour l'instant, génère un lien avec le code comme paramètre
        // Dans une vraie application, cela serait une URL complète avec le code
        return `?meeting=${meetingCode}`;
    }

    /**
     * Affiche le code de la réunion dans l'interface
     * @param {string} code - Code de la réunion
     */
    showMeetingCode(code) {
        const content = document.getElementById('meeting-details-content');
        if (!content) return;

        const link = this.generateInvitationLink(code);

        content.innerHTML = `
            <div class="meeting-code-section">
                <h3>Code de la réunion</h3>
                <div class="code-display">
                    <span class="code-text">${code}</span>
                    <button class="btn btn-sm btn-secondary btn-copy-code" data-code="${code}">
                        📋 Copier
                    </button>
                </div>
            </div>
            <div class="meeting-link-section">
                <h3>Lien d'invitation</h3>
                <div class="link-display">
                    <span class="link-text">${link}</span>
                    <button class="btn btn-sm btn-secondary btn-copy-link" data-link="${link}">
                        📋 Copier
                    </button>
                </div>
            </div>
        `;

        this.openModal('details-modal');
    }

    /**
     * Affiche la salle d'attente
     * @param {object} meeting - Détails de la réunion
     * @param {object} participant - Détails du participant
     */
    showWaitingRoom(meeting, participant) {
        this.currentMeeting = meeting;
        this.currentParticipant = participant;
        this.currentMeetingId = meeting.id;
        this.currentParticipantId = participant.id;

        // Masquer les vues principales
        document.querySelectorAll('.view').forEach(view => {
            view.classList.remove('active');
        });

        // Afficher la salle d'attente
        const waitingRoom = document.getElementById('view-waiting-room');
        if (waitingRoom) {
            waitingRoom.classList.add('active');
        }

        // Mettre à jour les informations
        const infoContainer = document.getElementById('waiting-room-info');
        if (infoContainer) {
            const startDate = new Date(meeting.startDateTime);
            const formattedDate = startDate.toLocaleDateString('fr-FR', {
                weekday: 'long',
                day: 'numeric', 
                month: 'long' 
            });
            const formattedTime = startDate.toLocaleTimeString('fr-FR', { 
                hour: '2-digit', 
                minute: '2-digit' 
            });

            infoContainer.innerHTML = `
                <h2>${this.escapeHtml(meeting.title)}</h2>
                ${meeting.description ? `<p class="description">${this.escapeHtml(meeting.description)}</p>` : ''}
                <div class="info-grid">
                    <div class="info-item">
                        <span class="info-label">📅 Date:</span>
                        <span class="info-value">${formattedDate}</span>
                    </div>
                    <div class="info-item">
                        <span class="info-label">⏰ Heure:</span>
                        <span class="info-value">${formattedTime}</span>
                    </div>
                    <div class="info-item">
                        <span class="info-label">⏱️ Durée:</span>
                        <span class="info-value">${meeting.duration} min</span>
                    </div>
                    <div class="info-item">
                        <span class="info-label">👥 Participants:</span>
                        <span class="info-value" id="participants-count">1</span>
                    </div>
                </div>
            `;
        }

        // Charger les participants
        this.updateParticipantsList();
    }

    /**
     * Met à jour la liste des participants
     */
    async updateParticipantsList() {
        try {
            const participants = await this.getParticipants();
            const container = document.getElementById('participants-list');
            const countElement = document.getElementById('participants-count');

            if (countElement) {
                countElement.textContent = participants.length;
            }

            if (container) {
                container.innerHTML = participants.map(p => `
                    <div class="participant-item">
                        <span class="participant-name">${this.escapeHtml(p.name)}</span>
                        ${p.isOrganizer ? '<span class="participant-badge">Organisateur</span>' : ''}
                    </div>
                `).join('');
            }

        } catch (error) {
            console.error('[MeetingManager] Erreur mise à jour participants:', error);
        }
    }

    /**
     * Affiche la salle de réunion
     */
    async showMeetingRoom() {
        // Masquer la salle d'attente
        const waitingRoom = document.getElementById('view-waiting-room');
        if (waitingRoom) {
            waitingRoom.classList.remove('active');
        }

        // Afficher la salle de réunion
        const meetingRoom = document.getElementById('view-meeting-room');
        if (meetingRoom) {
            meetingRoom.classList.add('active');
        }

        // Mettre à jour le titre
        document.getElementById('page-title').textContent = 'Salle de réunion';

        // Initialiser WebRTC
        try {
            // Initialiser le média local (audio par défaut)
            const stream = await this.initializeLocalMedia(true, false);

            // Afficher le flux local
            const localVideo = document.getElementById('local-video');
            if (localVideo) {
                localVideo.srcObject = stream;
            }

            // Initialiser les connexions WebRTC avec tous les participants
            await this.initializeWebRTCForMeeting();

            // Mettre à jour la liste des participants dans la salle
            this.updateRoomParticipantsList();

            // Mettre à jour les boutons média
            if (typeof updateMediaButtons === 'function') {
                updateMediaButtons();
            }

        } catch (error) {
            console.error('[MeetingManager] Erreur initialisation WebRTC:', error);
            this.showToast('Erreur d\'initialisation de la vidéo', 'error');
        }
    }

    /**
     * Met à jour la liste des participants dans la salle de réunion
     */
    async updateRoomParticipantsList() {
        try {
            const participants = await this.getParticipants();
            const container = document.getElementById('room-participants-list');

            if (container) {
                container.innerHTML = participants.map(p => `
                    <div class="participant-item">
                        <span class="participant-name">${this.escapeHtml(p.name)}</span>
                        ${p.isOrganizer ? '<span class="participant-badge">Organisateur</span>' : ''}
                    </div>
                `).join('');
            }

        } catch (error) {
            console.error('[MeetingManager] Erreur mise à jour participants salle:', error);
        }
    }

    /**
     * Quitte la salle et retourne au tableau de bord
     */
    async exitMeetingRoom() {
        try {
            // Nettoyer WebRTC
            this.cleanupWebRTC();

            await this.leaveMeeting();

            // Masquer la salle de réunion
            const meetingRoom = document.getElementById('view-meeting-room');
            if (meetingRoom) {
                meetingRoom.classList.remove('active');
            }

            // Retourner au tableau de bord
            this.showView('dashboard');
            this.loadDashboard();

        } catch (error) {
            console.error('[MeetingManager] Erreur sortie salle:', error);
            this.showToast('Erreur lors de la sortie', 'error');
        }
    }

    // ==================== MODULE 5: WEBRTC ====================

    /**
     * Initialise le média local (audio et/ou vidéo)
     * @param {boolean} audio - Activer l'audio
     * @param {boolean} video - Activer la vidéo
     * @returns {Promise<MediaStream>} Flux média local
     */
    async initializeLocalMedia(audio = true, video = false) {
        try {
            console.log('[WebRTC] Initialisation média local:', { audio, video });

            const constraints = {
                audio: audio ? {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                } : false,
                video: video ? {
                    facingMode: 'user'
                } : false
            };

            // Sur mobile, utiliser les API spécifiques si disponibles
            if (window.cordova && window.cordova.plugins && window.cordova.plugins.iosrtc) {
                console.log('[WebRTC] Utilisation de cordova-plugin-iosrtc');
                this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
            } else {
                this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
            }

            this.mediaState.audioEnabled = audio;
            this.mediaState.videoEnabled = video;

            console.log('[WebRTC] Flux local initialisé avec succès');
            return this.localStream;

        } catch (error) {
            console.error('[WebRTC] Erreur initialisation média local:', error);
            throw new Error('Impossible d\'accéder aux périphériques: ' + error.message);
        }
    }

    /**
     * Crée une RTCPeerConnection pour un participant
     * @param {string} participantId - ID du participant
     * @returns {RTCPeerConnection} Connexion peer
     */
    createPeerConnection(participantId) {
        try {
            console.log('[WebRTC] Création PeerConnection pour', participantId);

            const pc = new RTCPeerConnection(this.iceServers);

            // Ajouter le flux local si disponible
            if (this.localStream) {
                this.localStream.getTracks().forEach(track => {
                    pc.addTrack(track, this.localStream);
                    console.log('[WebRTC] Piste ajoutée:', track.kind);
                });
            }

            // Écouter les ICE candidates
            pc.onicecandidate = (event) => {
                if (event.candidate) {
                    console.log('[WebRTC] ICE candidate reçue pour', participantId);
                    this.sendIceCandidate(participantId, event.candidate);
                }
            };

            // Écouter les ICE connection state changes
            pc.oniceconnectionstatechange = () => {
                console.log('[WebRTC] ICE state pour', participantId, ':', pc.iceConnectionState);
                if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
                    console.warn('[WebRTC] Connexion ICE échouée pour', participantId);
                    this.handlePeerConnectionFailure(participantId);
                }
            };

            // Écouter les flux distants
            pc.ontrack = (event) => {
                console.log('[WebRTC] Piste distante reçue de', participantId, ':', event.track.kind);
                this.handleRemoteTrack(participantId, event.streams[0], event.track);
            };

            this.peerConnections.set(participantId, pc);
            return pc;

        } catch (error) {
            console.error('[WebRTC] Erreur création PeerConnection:', error);
            throw error;
        }
    }

    /**
     * Crée et envoie une offre SDP à un participant
     * @param {string} participantId - ID du participant
     */
    async createOffer(participantId) {
        try {
            console.log('[WebRTC] Création offre pour', participantId);

            const pc = this.peerConnections.get(participantId);
            if (!pc) {
                throw new Error('PeerConnection non trouvée pour ' + participantId);
            }

            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);

            console.log('[WebRTC] Offre créée et setLocalDescription');

            // Envoyer l'offre via WebSocket
            this.send({
                type: 'WEBRTC_OFFER',
                meetingId: this.currentMeetingId,
                fromParticipantId: this.currentParticipantId,
                toParticipantId: participantId,
                offer: offer
            });

        } catch (error) {
            console.error('[WebRTC] Erreur création offre:', error);
            throw error;
        }
    }

    /**
     * Crée et envoie une réponse SDP à une offre reçue
     * @param {string} participantId - ID du participant
     * @param {RTCSessionDescription} offer - Offre reçue
     */
    async createAnswer(participantId, offer) {
        try {
            console.log('[WebRTC] Création réponse pour', participantId);

            const pc = this.peerConnections.get(participantId);
            if (!pc) {
                pc = this.createPeerConnection(participantId);
            }

            await pc.setRemoteDescription(new RTCSessionDescription(offer));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);

            console.log('[WebRTC] Réponse créée et setLocalDescription');

            // Envoyer la réponse via WebSocket
            this.send({
                type: 'WEBRTC_ANSWER',
                meetingId: this.currentMeetingId,
                fromParticipantId: this.currentParticipantId,
                toParticipantId: participantId,
                answer: answer
            });

        } catch (error) {
            console.error('[WebRTC] Erreur création réponse:', error);
            throw error;
        }
    }

    /**
     * Envoie un ICE candidate à un participant
     * @param {string} participantId - ID du participant
     * @param {RTCIceCandidate} candidate - ICE candidate
     */
    sendIceCandidate(participantId, candidate) {
        try {
            this.send({
                type: 'WEBRTC_ICE_CANDIDATE',
                meetingId: this.currentMeetingId,
                fromParticipantId: this.currentParticipantId,
                toParticipantId: participantId,
                candidate: candidate
            });
        } catch (error) {
            console.error('[WebRTC] Erreur envoi ICE candidate:', error);
        }
    }

    /**
     * Gère une offre WebRTC reçue
     * @param {object} message - Message WebSocket
     */
    async handleWebRTCOffer(message) {
        try {
            const { fromParticipantId, offer } = message;
            console.log('[WebRTC] Offre reçue de', fromParticipantId);

            await this.createAnswer(fromParticipantId, offer);

        } catch (error) {
            console.error('[WebRTC] Erreur traitement offre:', error);
        }
    }

    /**
     * Gère une réponse WebRTC reçue
     * @param {object} message - Message WebSocket
     */
    async handleWebRTCAnswer(message) {
        try {
            const { fromParticipantId, answer } = message;
            console.log('[WebRTC] Réponse reçue de', fromParticipantId);

            const pc = this.peerConnections.get(fromParticipantId);
            if (pc) {
                await pc.setRemoteDescription(new RTCSessionDescription(answer));
                console.log('[WebRTC] setRemoteDescription effectué');
            }

        } catch (error) {
            console.error('[WebRTC] Erreur traitement réponse:', error);
        }
    }

    /**
     * Gère un ICE candidate reçu
     * @param {object} message - Message WebSocket
     */
    async handleWebRTCIceCandidate(message) {
        try {
            const { fromParticipantId, candidate } = message;
            console.log('[WebRTC] ICE candidate reçue de', fromParticipantId);

            const pc = this.peerConnections.get(fromParticipantId);
            if (pc) {
                await pc.addIceCandidate(new RTCIceCandidate(candidate));
                console.log('[WebRTC] ICE candidate ajoutée');
            }

        } catch (error) {
            console.error('[WebRTC] Erreur traitement ICE candidate:', error);
        }
    }

    /**
     * Gère une piste distante reçue
     * @param {string} participantId - ID du participant
     * @param {MediaStream} stream - Flux média
     * @param {MediaStreamTrack} track - Piste média
     */
    handleRemoteTrack(participantId, stream, track) {
        console.log('[WebRTC] Piste distante:', participantId, track.kind);

        // Stocker le flux distant
        if (!this.remoteStreams.has(participantId)) {
            this.remoteStreams.set(participantId, stream);
        }

        // Notifier l'interface
        this.emitEvent('remoteTrackAdded', {
            participantId: participantId,
            stream: stream,
            track: track
        });
    }

    /**
     * Gère l'échec d'une connexion peer
     * @param {string} participantId - ID du participant
     */
    handlePeerConnectionFailure(participantId) {
        console.warn('[WebRTC] Échec connexion peer:', participantId);

        // Nettoyer la connexion
        this.closePeerConnection(participantId);

        // Notifier l'interface
        this.emitEvent('peerConnectionFailed', {
            participantId: participantId
        });
    }

    /**
     * Ferme proprement une PeerConnection
     * @param {string} participantId - ID du participant
     */
    closePeerConnection(participantId) {
        const pc = this.peerConnections.get(participantId);
        if (pc) {
            pc.close();
            this.peerConnections.delete(participantId);
            console.log('[WebRTC] PeerConnection fermée pour', participantId);
        }

        // Retirer le flux distant
        this.remoteStreams.delete(participantId);
    }

    /**
     * Ferme toutes les PeerConnections
     */
    closeAllPeerConnections() {
        console.log('[WebRTC] Fermeture de toutes les PeerConnections');
        this.peerConnections.forEach((pc, participantId) => {
            this.closePeerConnection(participantId);
        });
        this.peerConnections.clear();
        this.remoteStreams.clear();
    }

    /**
     * Active/désactive le microphone
     * @param {boolean} enabled - État du microphone
     */
    async toggleAudio(enabled) {
        try {
            if (!this.localStream) {
                throw new Error('Flux local non initialisé');
            }

            const audioTrack = this.localStream.getAudioTracks()[0];
            if (audioTrack) {
                audioTrack.enabled = enabled;
                this.mediaState.audioEnabled = enabled;
                console.log('[WebRTC] Microphone:', enabled ? 'activé' : 'désactivé');

                // Notifier les autres participants
                this.notifyMediaStateChange();
            }

        } catch (error) {
            console.error('[WebRTC] Erreur toggle audio:', error);
            throw error;
        }
    }

    /**
     * Active/désactive la caméra
     * @param {boolean} enabled - État de la caméra
     */
    async toggleVideo(enabled) {
        try {
            if (!this.localStream) {
                // Si pas de flux, l'initialiser avec vidéo
                if (enabled) {
                    await this.initializeLocalMedia(this.mediaState.audioEnabled, true);
                    // Mettre à jour toutes les PeerConnections
                    await this.updateAllPeerConnections();
                }
                return;
            }

            const videoTrack = this.localStream.getVideoTracks()[0];
            if (videoTrack) {
                videoTrack.enabled = enabled;
                this.mediaState.videoEnabled = enabled;
                console.log('[WebRTC] Caméra:', enabled ? 'activée' : 'désactivée');

                // Notifier les autres participants
                this.notifyMediaStateChange();
            } else if (enabled) {
                // Ajouter la vidéo si pas de piste vidéo
                await this.addVideoTrack();
            }

        } catch (error) {
            console.error('[WebRTC] Erreur toggle video:', error);
            throw error;
        }
    }

    /**
     * Ajoute une piste vidéo au flux local (transition audio → vidéo)
     */
    async addVideoTrack() {
        try {
            console.log('[WebRTC] Ajout piste vidéo');

            const videoStream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: 'user' }
            });

            const videoTrack = videoStream.getVideoTracks()[0];

            // Ajouter à toutes les PeerConnections
            this.peerConnections.forEach((pc) => {
                pc.addTrack(videoTrack, videoStream);
            });

            // Fusionner avec le flux local existant
            if (this.localStream) {
                videoStream.getAudioTracks().forEach(track => {
                    this.localStream.addTrack(track);
                });
            }
            this.localStream = videoStream;

            this.mediaState.videoEnabled = true;

            // Renégocier avec tous les participants
            await this.renegotiateWithAllParticipants();

        } catch (error) {
            console.error('[WebRTC] Erreur ajout piste vidéo:', error);
            throw error;
        }
    }

    /**
     * Met à jour toutes les PeerConnections après changement de média
     */
    async updateAllPeerConnections() {
        console.log('[WebRTC] Mise à jour de toutes les PeerConnections');

        for (const [participantId, pc] of this.peerConnections) {
            try {
                // Renégocier
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);

                this.send({
                    type: 'WEBRTC_RENEGOTIATION',
                    meetingId: this.currentMeetingId,
                    fromParticipantId: this.currentParticipantId,
                    toParticipantId: participantId,
                    offer: offer
                });
            } catch (error) {
                console.error('[WebRTC] Erreur mise à jour PC pour', participantId, error);
            }
        }
    }

    /**
     * Renégocie avec tous les participants
     */
    async renegotiateWithAllParticipants() {
        console.log('[WebRTC] Renégociation avec tous les participants');
        await this.updateAllPeerConnections();
    }

    /**
     * Notifie les participants d'un changement d'état média
     */
    notifyMediaStateChange() {
        this.send({
            type: 'MEDIA_STATE_CHANGED',
            meetingId: this.currentMeetingId,
            participantId: this.currentParticipantId,
            state: this.mediaState
        });
    }

    /**
     * Gère un changement d'état média d'un participant
     * @param {object} message - Message WebSocket
     */
    handleMediaStateChanged(message) {
        const { participantId, state } = message;
        console.log('[WebRTC] État média changé pour', participantId, state);

        this.emitEvent('mediaStateChanged', {
            participantId: participantId,
            state: state
        });
    }

    /**
     * Démarre le partage d'écran
     */
    async startScreenShare() {
        try {
            console.log('[WebRTC] Démarrage partage d\'écran');

            // Vérifier si le plugin est disponible sur mobile
            if (window.cordova && window.ScreenShareLive) {
                const available = await new Promise((resolve) => {
                    ScreenShareLive.isAvailable(resolve, () => resolve(false));
                });

                if (available) {
                    console.log('[WebRTC] Utilisation du plugin ScreenShareLive');
                    await this.startScreenShareWithPlugin();
                    return;
                }
            }

            // Utiliser getDisplayMedia sur desktop/Android WebView
            if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
                throw new Error('Partage d\'écran non supporté sur cette plateforme');
            }

            this.screenStream = await navigator.mediaDevices.getDisplayMedia({
                video: true,
                audio: false
            });

            // Remplacer la piste vidéo dans toutes les PeerConnections
            const videoTrack = this.screenStream.getVideoTracks()[0];
            this.peerConnections.forEach((pc) => {
                const sender = pc.getSenders().find(s => s.track.kind === 'video');
                if (sender) {
                    sender.replaceTrack(videoTrack);
                }
            });

            this.mediaState.screenSharing = true;

            // Notifier les participants
            this.send({
                type: 'SCREEN_SHARE_STARTED',
                meetingId: this.currentMeetingId,
                participantId: this.currentParticipantId
            });

            // Gérer l'arrêt du partage par l'utilisateur
            videoTrack.onended = () => {
                this.stopScreenShare();
            };

            console.log('[WebRTC] Partage d\'écran démarré (getDisplayMedia)');

        } catch (error) {
            console.error('[WebRTC] Erreur démarrage partage d\'écran:', error);
            throw error;
        }
    }

    /**
     * Démarre le partage d'écran avec le plugin ScreenShareLive (mobile)
     */
    async startScreenShareWithPlugin() {
        try {
            console.log('[WebRTC] Démarrage partage avec plugin ScreenShareLive');

            // Créer le canvas stream
            this.screenCanvasStream = ScreenShareLive.createCanvasStream(10);
            this.screenStream = this.screenCanvasStream.stream;

            // Démarrer la capture native
            ScreenShareLive.start(
                {
                    maxWidth: 720,
                    maxFps: 10,
                    jpegQuality: 55,
                    useBroadcast: true
                },
                (message) => {
                    // Callback keepCallback pour recevoir les frames
                    if (message === 'started') {
                        console.log('[WebRTC] Capture native démarrée');
                        this.mediaState.screenSharing = true;

                        // Remplacer la piste vidéo dans toutes les PeerConnections
                        const videoTrack = this.screenStream.getVideoTracks()[0];
                        this.peerConnections.forEach((pc) => {
                            const sender = pc.getSenders().find(s => s.track.kind === 'video');
                            if (sender) {
                                sender.replaceTrack(videoTrack);
                            }
                        });

                        // Notifier les participants
                        this.send({
                            type: 'SCREEN_SHARE_STARTED',
                            meetingId: this.currentMeetingId,
                            participantId: this.currentParticipantId
                        });
                    } else if (message === 'stopped') {
                        console.log('[WebRTC] Capture native arrêtée');
                        this.stopScreenShare();
                    } else if (message && message.type === 'frame' && message.jpeg) {
                        // Nouvelle frame JPEG reçue, l'ajouter au canvas
                        this.screenCanvasStream.pushJpegBase64(message.jpeg);
                    }
                },
                (error) => {
                    console.error('[WebRTC] Erreur plugin ScreenShareLive:', error);
                    this.stopScreenShare();
                    throw new Error('Erreur plugin de partage d\'écran: ' + error);
                }
            );

            console.log('[WebRTC] Partage d\'écran démarré (plugin)');

        } catch (error) {
            console.error('[WebRTC] Erreur démarrage partage avec plugin:', error);
            throw error;
        }
    }

    /**
     * Arrête le partage d'écran
     */
    async stopScreenShare() {
        try {
            console.log('[WebRTC] Arrêt partage d\'écran');

            // Arrêter le plugin si actif
            if (window.cordova && window.ScreenShareLive && this.mediaState.screenSharing) {
                await new Promise((resolve, reject) => {
                    ScreenShareLive.stop(resolve, reject);
                });
            }

            // Nettoyer le canvas stream
            if (this.screenCanvasStream) {
                this.screenCanvasStream.destroy();
                this.screenCanvasStream = null;
            }

            // Arrêter le stream natif
            if (this.screenStream) {
                this.screenStream.getTracks().forEach(track => track.stop());
                this.screenStream = null;
            }

            // Restaurer la caméra si elle était activée
            if (this.mediaState.videoEnabled && this.localStream) {
                const videoTrack = this.localStream.getVideoTracks()[0];
                if (videoTrack) {
                    this.peerConnections.forEach((pc) => {
                        const sender = pc.getSenders().find(s => s.track.kind === 'video');
                        if (sender) {
                            sender.replaceTrack(videoTrack);
                        }
                    });
                }
            }

            this.mediaState.screenSharing = false;

            // Notifier les participants
            this.send({
                type: 'SCREEN_SHARE_STOPPED',
                meetingId: this.currentMeetingId,
                participantId: this.currentParticipantId
            });

            console.log('[WebRTC] Partage d\'écran arrêté');

        } catch (error) {
            console.error('[WebRTC] Erreur arrêt partage d\'écran:', error);
            throw error;
        }
    }

    /**
     * Gère le début de partage d'écran d'un participant
     * @param {object} message - Message WebSocket
     */
    handleScreenShareStarted(message) {
        const { participantId } = message;
        console.log('[WebRTC] Partage d\'écran démarré par', participantId);

        this.emitEvent('screenShareStarted', {
            participantId: participantId
        });
    }

    /**
     * Gère l'arrêt de partage d'écran d'un participant
     * @param {object} message - Message WebSocket
     */
    handleScreenShareStopped(message) {
        const { participantId } = message;
        console.log('[WebRTC] Partage d\'écran arrêté par', participantId);

        this.emitEvent('screenShareStopped', {
            participantId: participantId
        });
    }

    /**
     * Bascule entre caméra avant et arrière (mobile)
     */
    async switchCamera() {
        try {
            console.log('[WebRTC] Basculement caméra');

            if (!this.localStream) {
                throw new Error('Flux local non initialisé');
            }

            const videoTrack = this.localStream.getVideoTracks()[0];
            if (!videoTrack) {
                throw new Error('Pas de piste vidéo');
            }

            const currentConstraints = videoTrack.getSettings();
            const newFacingMode = currentConstraints.facingMode === 'user' ? 'environment' : 'user';

            // Arrêter la piste actuelle
            videoTrack.stop();

            // Obtenir un nouveau flux avec la caméra opposée
            const newStream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: newFacingMode }
            });

            const newVideoTrack = newStream.getVideoTracks()[0];

            // Remplacer dans toutes les PeerConnections
            this.peerConnections.forEach((pc) => {
                const sender = pc.getSenders().find(s => s.track.kind === 'video');
                if (sender) {
                    sender.replaceTrack(newVideoTrack);
                }
            });

            // Mettre à jour le flux local
            this.localStream.removeTrack(videoTrack);
            this.localStream.addTrack(newVideoTrack);

            console.log('[WebRTC] Caméra basculée vers', newFacingMode);

        } catch (error) {
            console.error('[WebRTC] Erreur basculement caméra:', error);
            throw error;
        }
    }

    /**
     * Nettoie toutes les ressources WebRTC
     */
    cleanupWebRTC() {
        console.log('[WebRTC] Nettoyage ressources');

        // Arrêter le flux local
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => {
                track.stop();
            });
            this.localStream = null;
        }

        // Arrêter le flux de partage d'écran
        if (this.screenStream) {
            this.screenStream.getTracks().forEach(track => {
                track.stop();
            });
            this.screenStream = null;
        }

        // Fermer toutes les PeerConnections
        this.closeAllPeerConnections();

        // Réinitialiser l'état
        this.mediaState = {
            audioEnabled: false,
            videoEnabled: false,
            screenSharing: false
        };
    }

    /**
     * Initialise les connexions WebRTC avec tous les participants
     */
    async initializeWebRTCForMeeting() {
        try {
            console.log('[WebRTC] Initialisation WebRTC pour la réunion');

            // Récupérer les participants
            const participants = await this.getParticipants();

            // Créer une PeerConnection pour chaque participant
            for (const participant of participants) {
                if (participant.id !== this.currentParticipantId) {
                    console.log('[WebRTC] Création connexion avec', participant.id);
                    this.createPeerConnection(participant.id);
                    // Créer une offre pour ce participant
                    await this.createOffer(participant.id);
                }
            }

        } catch (error) {
            console.error('[WebRTC] Erreur initialisation WebRTC:', error);
            throw error;
        }
    }
}
