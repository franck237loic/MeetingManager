/**
 * index.js
 * Initialisation de l'application Meeting Manager
 * Gère les événements de l'interface utilisateur
 */

// Variable globale pour MeetingManager
let meetingManager = null;
let currentFilter = 'all';
let confirmCallback = null;

// Initialisation
document.addEventListener('DOMContentLoaded', () => {
    console.log('[App] DOM chargé');
    initializeMeetingManager();
});

// Pour Cordova (device ready)
document.addEventListener('deviceready', () => {
    console.log('[App] Cordova device ready');
    if (!meetingManager) {
        initializeMeetingManager();
    }
});

/**
 * Initialise le MeetingManager et l'interface
 */
function initializeMeetingManager() {
    try {
        console.log('[App] Initialisation de MeetingManager...');
        
        // Créer une instance de MeetingManager
        meetingManager = new MeetingManager();
        
        // Enregistrer les handlers WebSocket
        meetingManager.on('connection', (message) => {
            console.log('[App] Connexion établie:', message);
            meetingManager.updateConnectionStatus(true);
        });
        
        meetingManager.on('pong', (message) => {
            console.log('[App] Pong reçu:', message.timestamp);
        });
        
        meetingManager.on('ack', (message) => {
            console.log('[App] Accusé de réception:', message);
        });

        // Enregistrer les handlers d'événements de réunion

        // Handlers MODULE 4: Participants
        meetingManager.onEvent('meetingJoined', (data) => {
            console.log('[App] Réunion rejointe:', data.meeting.id);
            meetingManager.showWaitingRoom(data.meeting, data.participant);
        });

        meetingManager.onEvent('meetingLeft', () => {
            console.log('[App] Réunion quittée');
        });

        // Handlers WebSocket pour les notifications de participants
        meetingManager.on('PARTICIPANT_JOINED', (message) => {
            console.log('[App] Participant rejoint:', message.participant.name);
            meetingManager.showToast(`${message.participant.name} a rejoint la réunion`, 'success');
            if (meetingManager.currentMeetingId) {
                meetingManager.updateParticipantsList();

                // Créer une connexion WebRTC avec le nouveau participant
                if (meetingManager.localStream) {
                    meetingManager.createPeerConnection(message.participant.id);
                    meetingManager.createOffer(message.participant.id);
                }
            }
        });

        meetingManager.on('PARTICIPANT_LEFT', (message) => {
            console.log('[App] Participant parti:', message.participantId);
            meetingManager.showToast('Un participant a quitté la réunion', 'info');
            if (meetingManager.currentMeetingId) {
                meetingManager.updateParticipantsList();

                // Nettoyer la connexion WebRTC
                meetingManager.closePeerConnection(message.participantId);
                removeRemoteVideo(message.participantId);
            }
        });

        // ==================== MODULE 5: HANDLERS WEBRTC ====================

        // Handler pour piste distante ajoutée
        meetingManager.onEvent('remoteTrackAdded', (data) => {
            console.log('[App] Piste distante ajoutée:', data.participantId);
            addRemoteVideo(data.participantId, data.stream);
        });

        // Handler pour échec de connexion peer
        meetingManager.onEvent('peerConnectionFailed', (data) => {
            console.warn('[App] Connexion peer échouée:', data.participantId);
            meetingManager.showToast('Connexion perdue avec un participant', 'error');
            removeRemoteVideo(data.participantId);
        });

        // Handler pour changement d'état média
        meetingManager.onEvent('mediaStateChanged', (data) => {
            console.log('[App] État média changé:', data.participantId, data.state);
            updateParticipantMediaState(data.participantId, data.state);
        });

        // Handler pour début partage d'écran
        meetingManager.onEvent('screenShareStarted', (data) => {
            console.log('[App] Partage d\'écran démarré par:', data.participantId);
            meetingManager.showToast('Partage d\'écran démarré', 'info');
            updateScreenShareState(data.participantId, true);
        });

        // Handler pour arrêt partage d'écran
        meetingManager.onEvent('screenShareStopped', (data) => {
            console.log('[App] Partage d\'écran arrêté par:', data.participantId);
            meetingManager.showToast('Partage d\'écran arrêté', 'info');
            updateScreenShareState(data.participantId, false);
        });

        // Initialiser la connexion
        meetingManager.initialize('wss://meeting-server-vrpf.onrender.com')
            .then(() => {
                console.log('[App] MeetingManager initialisé avec succès');
                meetingManager.updateConnectionStatus(true);
                
                // Charger les données initiales
                loadDashboard();
                
                // Tester la connexion
                setTimeout(() => {
                    if (meetingManager.getConnectionStatus()) {
                        meetingManager.ping();
                    }
                }, 1000);
            })
            .catch((error) => {
                console.error('[App] Erreur initialisation MeetingManager:', error);
                meetingManager.updateConnectionStatus(false);
                meetingManager.showToast('Erreur de connexion au serveur', 'error');
            });
            
        // Initialiser les événements de l'interface
        initializeUIEvents();
            
    } catch (error) {
        console.error('[App] Erreur lors de l\'initialisation:', error.message);
    }
}

/**
 * Initialise les événements de l'interface utilisateur
 */
function initializeUIEvents() {
    // Navigation
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', () => {
            const view = item.dataset.view;
            meetingManager.showView(view);
            
            if (view === 'dashboard') {
                loadDashboard();
            } else if (view === 'meetings') {
                loadMeetingsWithFilter(currentFilter);
            } else if (view === 'join') {
                // Vue de rejoindre
            }
        });
    });

    // Bouton nouvelle réunion
    const btnNewMeeting = document.getElementById('btn-new-meeting');
    if (btnNewMeeting) {
        btnNewMeeting.addEventListener('click', () => {
            meetingManager.openMeetingModal(null);
        });
    }

    // Filtres
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentFilter = btn.dataset.filter;
            loadMeetingsWithFilter(currentFilter);
        });
    });

    // Modal de création/modification
    const meetingForm = document.getElementById('meeting-form');
    if (meetingForm) {
        meetingForm.addEventListener('submit', handleMeetingFormSubmit);
    }

    // Boutons d'action sur les réunions (délégation d'événements)
    document.addEventListener('click', (e) => {
        // Bouton détails
        if (e.target.closest('.btn-view-details')) {
            const btn = e.target.closest('.btn-view-details');
            const meetingId = btn.dataset.meetingId;
            viewMeetingDetails(meetingId);
        }

        // Bouton afficher code
        if (e.target.closest('.btn-show-code')) {
            const btn = e.target.closest('.btn-show-code');
            const meetingCode = btn.dataset.meetingCode;
            showMeetingCode(meetingCode);
        }

        // Bouton copier code
        if (e.target.closest('.btn-copy-code')) {
            const btn = e.target.closest('.btn-copy-code');
            const code = btn.dataset.code;
            copyToClipboard(code, 'Code copié !');
        }

        // Bouton copier lien
        if (e.target.closest('.btn-copy-link')) {
            const btn = e.target.closest('.btn-copy-link');
            const link = btn.dataset.link;
            copyToClipboard(link, 'Lien copié !');
        }

        // Bouton modifier
        if (e.target.closest('.btn-edit')) {
            const btn = e.target.closest('.btn-edit');
            const meetingId = btn.dataset.meetingId;
            editMeeting(meetingId);
        }

        // Bouton annuler
        if (e.target.closest('.btn-cancel')) {
            const btn = e.target.closest('.btn-cancel');
            const meetingId = btn.dataset.meetingId;
            confirmCancelMeeting(meetingId);
        }
    });

    // Fermeture des modals
    document.querySelectorAll('.modal-close, .modal-cancel').forEach(btn => {
        btn.addEventListener('click', () => {
            meetingManager.closeAllModals();
        });
    });

    // Clic en dehors du modal pour fermer
    document.querySelectorAll('.modal').forEach(modal => {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                meetingManager.closeAllModals();
            }
        });
    });

    // Bouton de confirmation
    const confirmBtn = document.getElementById('confirm-btn');
    if (confirmBtn) {
        confirmBtn.addEventListener('click', () => {
            if (confirmCallback) {
                confirmCallback();
                confirmCallback = null;
            }
            meetingManager.closeAllModals();
        });
    }

    // Bouton rejoindre une réunion
    const btnJoin = document.getElementById('btn-join');
    if (btnJoin) {
        btnJoin.addEventListener('click', handleJoinMeeting);
    }

    // Bouton entrer dans la salle
    const btnEnterMeeting = document.getElementById('btn-enter-meeting');
    if (btnEnterMeeting) {
        btnEnterMeeting.addEventListener('click', async () => {
            try {
                await meetingManager.showMeetingRoom();
            } catch (error) {
                console.error('[App] Erreur entrée salle:', error);
                meetingManager.showToast('Erreur lors de l\'entrée dans la salle', 'error');
            }
        });
    }

    // Bouton quitter la salle d'attente
    const btnLeaveWaiting = document.getElementById('btn-leave-waiting');
    if (btnLeaveWaiting) {
        btnLeaveWaiting.addEventListener('click', async () => {
            try {
                await meetingManager.leaveMeeting();
                meetingManager.showView('dashboard');
                loadDashboard();
            } catch (error) {
                console.error('[App] Erreur quitter salle d\'attente:', error);
            }
        });
    }

    // Bouton quitter la salle de réunion
    const btnLeaveMeeting = document.getElementById('btn-leave-meeting');
    if (btnLeaveMeeting) {
        btnLeaveMeeting.addEventListener('click', () => {
            meetingManager.exitMeetingRoom();
        });
    }

    // ==================== MODULE 5: CONTRÔLES MÉDIA ====================

    // Bouton toggle microphone
    const btnToggleMic = document.getElementById('btn-toggle-mic');
    if (btnToggleMic) {
        btnToggleMic.addEventListener('click', async () => {
            try {
                const currentState = meetingManager.mediaState.audioEnabled;
                await meetingManager.toggleAudio(!currentState);
                updateMediaButtons();
            } catch (error) {
                console.error('[App] Erreur toggle microphone:', error);
                meetingManager.showToast('Erreur avec le microphone', 'error');
            }
        });
    }

    // Bouton toggle caméra
    const btnToggleCam = document.getElementById('btn-toggle-cam');
    if (btnToggleCam) {
        btnToggleCam.addEventListener('click', async () => {
            try {
                const currentState = meetingManager.mediaState.videoEnabled;
                await meetingManager.toggleVideo(!currentState);
                updateMediaButtons();
            } catch (error) {
                console.error('[App] Erreur toggle caméra:', error);
                meetingManager.showToast('Erreur avec la caméra', 'error');
            }
        });
    }

    // Bouton switch caméra (mobile)
    const btnSwitchCamera = document.getElementById('btn-switch-camera');
    if (btnSwitchCamera) {
        btnSwitchCamera.addEventListener('click', async () => {
            try {
                await meetingManager.switchCamera();
            } catch (error) {
                console.error('[App] Erreur switch caméra:', error);
                meetingManager.showToast('Erreur changement de caméra', 'error');
            }
        });
    }

    // Bouton partage d'écran
    const btnScreenShare = document.getElementById('btn-screen-share');
    if (btnScreenShare) {
        btnScreenShare.addEventListener('click', async () => {
            try {
                if (meetingManager.mediaState.screenSharing) {
                    await meetingManager.stopScreenShare();
                } else {
                    await meetingManager.startScreenShare();
                }
                updateMediaButtons();
            } catch (error) {
                console.error('[App] Erreur partage écran:', error);
                meetingManager.showToast('Erreur partage d\'écran', 'error');
            }
        });
    }
}

/**
 * Charge le tableau de bord
 */
async function loadDashboard() {
    if (meetingManager && meetingManager.getConnectionStatus()) {
        await meetingManager.loadDashboard();
    }
}

/**
 * Charge les réunions avec le filtre actuel
 */
async function loadMeetingsWithFilter(filter) {
    if (meetingManager && meetingManager.getConnectionStatus()) {
        await meetingManager.loadMeetingsWithFilter(filter);
    }
}

/**
 * Charge la vue actuelle
 */
function loadCurrentView() {
    const activeView = document.querySelector('.view.active');
    if (activeView) {
        if (activeView.id === 'view-dashboard') {
            loadDashboard();
        } else if (activeView.id === 'view-meetings') {
            loadMeetingsWithFilter(currentFilter);
        }
        // La vue join ne nécessite pas de chargement de données
    }
}

/**
 * Gère la soumission du formulaire de réunion
 */
async function handleMeetingFormSubmit(e) {
    e.preventDefault();

    if (!meetingManager || !meetingManager.getConnectionStatus()) {
        meetingManager.showToast('Non connecté au serveur', 'error');
        return;
    }

    const meetingId = document.getElementById('meeting-id').value;
    const title = document.getElementById('meeting-title').value;
    const description = document.getElementById('meeting-description').value;
    const date = document.getElementById('meeting-date').value;
    const time = document.getElementById('meeting-time').value;
    const duration = parseInt(document.getElementById('meeting-duration').value);
    const type = document.getElementById('meeting-type').value;
    const maxParticipants = parseInt(document.getElementById('meeting-participants').value);

    // Combiner date et heure
    const startDateTime = new Date(`${date}T${time}`);

    try {
        if (meetingId) {
            // Modification
            await meetingManager.updateMeeting(meetingId, {
                title: title,
                description: description,
                startDateTime: startDateTime.toISOString(),
                duration: duration,
                meetingType: type,
                maxParticipants: maxParticipants
            });
        } else {
            // Création
            const meeting = await meetingManager.createMeeting({
                title: title,
                description: description,
                startDateTime: startDateTime.toISOString(),
                duration: duration,
                meetingType: type,
                maxParticipants: maxParticipants
            });
            showMeetingCreatedView(meeting);
        }

        meetingManager.closeAllModals();
        loadDashboard();

    } catch (error) {
        console.error('[App] Erreur soumission formulaire:', error);
        meetingManager.showToast(error.message, 'error');
    }
}

/**
 * Affiche les détails d'une réunion
 */
async function viewMeetingDetails(meetingId) {
    try {
        const meeting = await meetingManager.getMeetingDetails(meetingId);
        meetingManager.showMeetingDetails(meeting);
    } catch (error) {
        console.error('[App] Erreur récupération détails:', error);
        meetingManager.showToast('Erreur lors du chargement des détails', 'error');
    }
}

/**
 * Ouvre le modal de modification
 */
async function editMeeting(meetingId) {
    try {
        const meeting = await meetingManager.getMeetingDetails(meetingId);
        meetingManager.openMeetingModal(meeting);
    } catch (error) {
        console.error('[App] Erreur récupération réunion:', error);
        meetingManager.showToast('Erreur lors du chargement de la réunion', 'error');
    }
}

/**
 * Demande confirmation pour annuler une réunion
 */
function confirmCancelMeeting(meetingId) {
    const message = document.getElementById('confirm-message');
    message.textContent = 'Êtes-vous sûr de vouloir annuler cette réunion ?';
    
    confirmCallback = async () => {
        try {
            await meetingManager.cancelMeeting(meetingId);
        } catch (error) {
            console.error('[App] Erreur annulation:', error);
            meetingManager.showToast('Erreur lors de l\'annulation', 'error');
        }
    };
    
    meetingManager.openModal('confirm-modal');
}

/**
 * Affiche le code de la réunion
 */
function showMeetingCode(code) {
    meetingManager.showMeetingCode(code);
}

/**
 * Copie du texte dans le presse-papiers
 */
function copyToClipboard(text, successMessage) {
    navigator.clipboard.writeText(text).then(() => {
        meetingManager.showToast(successMessage, 'success');
    }).catch(err => {
        console.error('[App] Erreur copie:', err);
        meetingManager.showToast('Erreur lors de la copie', 'error');
    });
}

/**
 * Gère le rejoindre une réunion
 */
async function handleJoinMeeting() {
    const codeInput = document.getElementById('join-code');
    const nameInput = document.getElementById('join-name');

    const code = codeInput.value.trim();
    const name = nameInput.value.trim() || 'Participant';

    if (!code) {
        meetingManager.showToast('Veuillez entrer un code de réunion', 'error');
        return;
    }

    try {
        // Nettoyer les vidéos existantes avant de rejoindre
        cleanupAllVideos();

        const result = await meetingManager.joinMeeting(code, null, name);
        meetingManager.showWaitingRoom(result.meeting, result.participant);
    } catch (error) {
        console.error('[App] Erreur rejoindre réunion:', error);
        meetingManager.showToast(error.message, 'error');
    }
}

// ==================== FONCTIONS UI RÉUNIONS (app_appel) ====================

/**
 * Affiche la vue de réunion créée
 */
function showMeetingCreatedView(meeting) {
    const html = `
        <div class="modal show" id="meeting-created-modal">
            <div class="modal-content">
                <div class="modal-header">
                    <h2>Réunion créée</h2>
                    <button class="modal-close" onclick="closeModal('meeting-created-modal')">×</button>
                </div>
                <div class="modal-body">
                    <div style="text-align: center; padding: 20px;">
                        <div style="font-size: 18px; font-weight: 500; margin-bottom: 10px;">${meeting.title}</div>
                        <div style="font-size: 12px; color: #8696a0; margin-bottom: 5px;">
                            ${new Date(meeting.startDateTime).toLocaleString('fr-FR')}
                        </div>
                        <div style="font-size: 12px; color: #8696a0; margin-bottom: 20px;">
                            Durée: ${meeting.duration} min • ${meeting.meetingType === 'video' ? 'Vidéo' : 'Audio'}
                        </div>

                        <div style="background: #222d34; padding: 15px; border-radius: 10px; margin-bottom: 15px;">
                            <div style="font-size: 11px; color: #8696a0; margin-bottom: 8px;">Code de la réunion</div>
                            <div style="font-size: 24px; font-weight: 600; color: #00a884; letter-spacing: 2px; margin-bottom: 10px;">
                                ${meeting.code}
                            </div>
                            <button onclick="copyToClipboard('${meeting.code}', 'Code copié !')"
                                    style="padding: 8px 16px; background: #374045; border: none; border-radius: 16px; color: white; cursor: pointer;">
                                Copier
                            </button>
                        </div>

                        <div style="display: flex; gap: 10px;">
                            <button onclick="startMeetingFromCreated('${meeting.code}')"
                                    style="flex: 1; padding: 12px; background: #00a884; border: none; border-radius: 20px; color: white; cursor: pointer;">
                                Commencer
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;

    document.body.insertAdjacentHTML('beforeend', html);
}

/**
 * Démarre une réunion depuis la vue créée
 */
async function startMeetingFromCreated(code) {
    closeModal('meeting-created-modal');
    try {
        const result = await meetingManager.joinMeeting(code);
        meetingManager.showWaitingRoom(result.meeting, result.participant);
    } catch (error) {
        console.error('[App] Erreur démarrage réunion:', error);
        meetingManager.showToast('Erreur lors du démarrage', 'error');
    }
}

/**
 * Rend la liste des réunions
 */
function renderMeetingList(data) {
    const content = document.getElementById('meeting-list-content');
    if (!content) return;

    let html = '';

    // Si data est un tableau direct (réponse du serveur)
    const meetings = Array.isArray(data) ? data : [];

    if (meetings.length > 0) {
        meetings.forEach(meeting => {
            const date = new Date(meeting.startDateTime);
            const dateStr = date.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
            const timeStr = date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

            html += `
                <div style="background: #222d34; padding: 15px; border-radius: 10px; margin-bottom: 10px;">
                    <div style="font-size: 16px; font-weight: 500; margin-bottom: 5px;">${meeting.title}</div>
                    <div style="font-size: 13px; color: #8696a0; margin-bottom: 5px;">${dateStr} à ${timeStr}</div>
                    <div style="display: flex; gap: 10px; margin-top: 10px;">
                        <button onclick="startMeetingFromCreated('${meeting.code}')"
                                style="flex: 1; padding: 8px; background: #00a884; border: none; border-radius: 8px; color: white; cursor: pointer;">
                            Démarrer
                        </button>
                        <button onclick="copyToClipboard('${meeting.code}', 'Code copié !')"
                                style="padding: 8px 16px; background: #374045; border: none; border-radius: 8px; color: white; cursor: pointer;">
                            Copier
                        </button>
                    </div>
                </div>
            `;
        });
    }

    if (!html) {
        html = '<div style="text-align: center; padding: 20px; color: #8696a0;">Aucune réunion</div>';
    }

    content.innerHTML = html;
}

/**
 * Ferme un modal
 */
function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.remove();
    }

    // Nettoyer le compte à rebours si nécessaire
    if (window.meetingCountdownInterval) {
        clearInterval(window.meetingCountdownInterval);
        window.meetingCountdownInterval = null;
    }
}

// ==================== MODULE 5: FONCTIONS UTILITAIRES WEBRTC ====================

/**
 * Met à jour l'état des boutons média
 */
function updateMediaButtons() {
    const btnMic = document.getElementById('btn-toggle-mic');
    const btnCam = document.getElementById('btn-toggle-cam');
    const btnScreenShare = document.getElementById('btn-screen-share');
    const localMicIndicator = document.getElementById('local-mic-indicator');
    const localCamIndicator = document.getElementById('local-cam-indicator');

    if (btnMic) {
        btnMic.className = 'btn btn-media ' + (meetingManager.mediaState.audioEnabled ? 'btn-mic-on' : 'btn-mic-off');
        btnMic.title = meetingManager.mediaState.audioEnabled ? 'Désactiver le microphone' : 'Activer le microphone';
    }

    if (btnCam) {
        btnCam.className = 'btn btn-media ' + (meetingManager.mediaState.videoEnabled ? 'btn-cam-on' : 'btn-cam-off');
        btnCam.title = meetingManager.mediaState.videoEnabled ? 'Désactiver la caméra' : 'Activer la caméra';
    }

    if (btnScreenShare) {
        btnScreenShare.className = 'btn btn-secondary control-btn ' + (meetingManager.mediaState.screenSharing ? 'btn-screen-share active' : '');
    }

    if (localMicIndicator) {
        localMicIndicator.className = 'indicator ' + (meetingManager.mediaState.audioEnabled ? '' : 'disabled');
    }

    if (localCamIndicator) {
        localCamIndicator.className = 'indicator ' + (meetingManager.mediaState.videoEnabled ? '' : 'disabled');
    }
}

/**
 * Ajoute une vidéo distante à la grille
 * @param {string} participantId - ID du participant
 * @param {MediaStream} stream - Flux média
 */
function addRemoteVideo(participantId, stream) {
    const videoGrid = document.getElementById('video-grid');
    if (!videoGrid) return;

    // Vérifier si la vidéo existe déjà
    const existingVideo = document.getElementById(`remote-video-${participantId}`);
    if (existingVideo) {
        return;
    }

    // Créer le conteneur vidéo
    const videoContainer = document.createElement('div');
    videoContainer.className = 'video-container remote-video';
    videoContainer.id = `video-container-${participantId}`;

    const video = document.createElement('video');
    video.id = `remote-video-${participantId}`;
    video.autoplay = true;
    video.playsInline = true;
    video.srcObject = stream;

    const label = document.createElement('div');
    label.className = 'video-label';
    label.textContent = `Participant ${participantId.substr(-4)}`;

    const indicators = document.createElement('div');
    indicators.className = 'video-indicators';
    indicators.innerHTML = `
        <span class="indicator mic-indicator" id="mic-${participantId}">🎤</span>
        <span class="indicator cam-indicator" id="cam-${participantId}">📷</span>
    `;

    videoContainer.appendChild(video);
    videoContainer.appendChild(label);
    videoContainer.appendChild(indicators);
    videoGrid.appendChild(videoContainer);

    console.log('[App] Vidéo distante ajoutée:', participantId);
}

/**
 * Retire une vidéo distante de la grille
 * @param {string} participantId - ID du participant
 */
function removeRemoteVideo(participantId) {
    const videoContainer = document.getElementById(`video-container-${participantId}`);
    if (videoContainer) {
        videoContainer.remove();
        console.log('[App] Vidéo distante retirée:', participantId);
    }
}

/**
 * Met à jour l'état média d'un participant
 * @param {string} participantId - ID du participant
 * @param {object} state - État média
 */
function updateParticipantMediaState(participantId, state) {
    const micIndicator = document.getElementById(`mic-${participantId}`);
    const camIndicator = document.getElementById(`cam-${participantId}`);

    if (micIndicator) {
        micIndicator.className = 'indicator ' + (state.audioEnabled ? '' : 'disabled');
    }

    if (camIndicator) {
        camIndicator.className = 'indicator ' + (state.videoEnabled ? '' : 'disabled');
    }
}

/**
 * Met à jour l'état de partage d'écran
 * @param {string} participantId - ID du participant
 * @param {boolean} isSharing - État de partage
 */
function updateScreenShareState(participantId, isSharing) {
    const videoContainer = document.getElementById(`video-container-${participantId}`);
    if (videoContainer) {
        if (isSharing) {
            videoContainer.classList.add('screen-sharing');
        } else {
            videoContainer.classList.remove('screen-sharing');
        }
    }
}

/**
 * Initialise la vidéo locale
 */
async function initializeLocalVideo() {
    try {
        const localVideo = document.getElementById('local-video');
        if (!localVideo) return;

        // Initialiser avec audio par défaut
        const stream = await meetingManager.initializeLocalMedia(true, false);
        localVideo.srcObject = stream;

        updateMediaButtons();

    } catch (error) {
        console.error('[App] Erreur initialisation vidéo locale:', error);
        meetingManager.showToast('Erreur d\'accès aux périphériques', 'error');
    }
}

/**
 * Nettoie toutes les vidéos
 */
function cleanupAllVideos() {
    const videoGrid = document.getElementById('video-grid');
    if (!videoGrid) return;

    // Retirer toutes les vidéos distantes
    const remoteVideos = videoGrid.querySelectorAll('.remote-video');
    remoteVideos.forEach(video => video.remove());

    // Arrêter la vidéo locale
    const localVideo = document.getElementById('local-video');
    if (localVideo && localVideo.srcObject) {
        localVideo.srcObject.getTracks().forEach(track => track.stop());
        localVideo.srcObject = null;
    }
}
