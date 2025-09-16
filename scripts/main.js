const API_URL = '/api';  


let currentJobId = null;
let pollingInterval = null;
let pollingAttempts = 0;
const MAX_POLLING_ATTEMPTS = 50; 
const INITIAL_POLLING_INTERVAL = 1000; 
const MAX_POLLING_INTERVAL = 5000; 
const BACKEND_WS = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${window.appConfig.BACKEND_WS}`; 


let jobWebSocket = null;
let wsReconnectAttempts = 0;
const MAX_WS_RECONNECT = 3;
let wsAlive = false;

async function classifyText() {
    const text = document.getElementById('emailText').value.trim();
    if (!text) {
        showError('Por favor, digite algum texto para classificar.');
        return;
    }
    await startClassification({ text });
}


async function classifyFile() {
    const fileInput = document.getElementById('emailFile');
    const file = fileInput.files[0];
    if (!file) {
        showError('Por favor, selecione um arquivo.');
        return;
    }
    const validTypes = ['text/plain', 'application/pdf'];
    if (!validTypes.includes(file.type)) {
        showError('Por favor, selecione um arquivo .txt ou .pdf.');
        return;
    }
    await startClassification(null, file);
}



async function startClassification(jsonData = null, file = null) {
    console.log('Iniciando classificação assíncrona...', { jsonData, file });

   
    retryCount = 0;
    showLoadingWithSteps();
    hideError();
    hideResults();
    closeJobWebSocket();
    stopPolling();

    try {
        let response;

        if (file || jsonData?.text) {
            const formData = new FormData();

            if (file) {
                formData.append('file', file);
                if (jsonData?.text) formData.append('text', jsonData.text);
            } else if (jsonData?.text) {
                formData.append('text', jsonData.text);
            }

            response = await fetch(`${API_URL}/classify-email`, {
                method: 'POST',
                body: formData,
                mode: 'cors'
            });
        } else {
            response = await fetch(`${API_URL}/classify-email`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(jsonData || {}),
                mode: 'cors'
            });
        }

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Erro ${response.status}: ${errorText}`);
        }

        const jobData = await response.json();
        console.log('Job criado:', jobData);

        currentJobId = jobData.job_id;

        openJobWebSocket(currentJobId);


        setTimeout(() => {
            if (!wsAlive) {
                console.warn('WebSocket não conectado — iniciando polling como fallback');
                startAdaptivePolling(currentJobId);
            }
        }, 1200);

    } catch (error) {
        console.error('Erro ao iniciar job:', error);
        showError(`Erro ao iniciar processamento: ${error.message}`);
        hideLoading();
    }
}


function openJobWebSocket(jobId) {
    closeJobWebSocket(); 

    const wsUrl = `${BACKEND_WS}/ws/job-status/${jobId}`;
    console.log('Tentando abrir WebSocket em', wsUrl);

    try {
        jobWebSocket = new WebSocket(wsUrl);

        jobWebSocket.onopen = () => {
            console.log('WebSocket conectado para job', jobId.substring(0, 8));
            wsAlive = true;
            wsReconnectAttempts = 0;
        };

        jobWebSocket.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);

                updateProgressUI(data);

                if (data.status === 'completed') {
                    handleJobCompleted(data);
                    closeJobWebSocket();
                } else if (data.status === 'failed') {
                    handleJobFailed(data);
                    closeJobWebSocket();
                }

            } catch (err) {
                console.warn('Erro ao parsear mensagem WS:', err, event.data);
            }
        };


        jobWebSocket.onerror = (err) => {
            console.error('WebSocket error:', err);
        };

        jobWebSocket.onclose = (ev) => {
            console.log('WebSocket fechado', ev);
            wsAlive = false;
            jobWebSocket = null;

            if (ev.code !== 1000 && wsReconnectAttempts < MAX_WS_RECONNECT) {
                wsReconnectAttempts++;
                const backoff = 500 * wsReconnectAttempts;
                console.warn(`Tentando reconectar WS (tentativa ${wsReconnectAttempts}) em ${backoff}ms`);
                setTimeout(() => openJobWebSocket(jobId), backoff);
            } else {
                if (currentJobId === jobId) {
                    console.info('Fallback para polling ativado após WS close');
                    startAdaptivePolling(jobId);
                }
            }
        };

    } catch (e) {
        console.error('Falha ao abrir WebSocket:', e);
        wsAlive = false;
        jobWebSocket = null;
        startAdaptivePolling(jobId);
    }
}

function closeJobWebSocket() {
    if (jobWebSocket) {
        try {
            jobWebSocket.close(1000, 'client_close');
        } catch (e) {
            console.warn('Erro ao fechar WS:', e);
        }
        jobWebSocket = null;
        wsAlive = false;
    }
}

function startAdaptivePolling(jobId) {
    console.log('🚀 Iniciando polling adaptativo (fallback) para job:', jobId.substring(0, 8));

    stopPolling();
    currentJobId = jobId;
    pollingAttempts = 0;

    let currentInterval = INITIAL_POLLING_INTERVAL;

    const poll = async () => {
        if (currentJobId !== jobId) {
            console.log('Polling cancelado - job mudou');
            return;
        }

        pollingAttempts++;
        if (pollingAttempts > MAX_POLLING_ATTEMPTS) {
            console.error('❌ Limite máximo de polling atingido');
            showError('Tempo limite excedido. O processamento está demorando muito.');
            stopPolling();
            return;
        }

        try {
            const statusData = await checkJobStatus(jobId);
            if (!statusData) return;


            if (statusData.status === 'processing' || statusData.status === 'classifying') {
                currentInterval = Math.max(800, currentInterval * 0.9);
            } else if (statusData.status === 'completed' || statusData.status === 'failed') {
                stopPolling();
                return;
            } else {
                currentInterval = Math.min(MAX_POLLING_INTERVAL, currentInterval * 1.1);
            }

            if (currentJobId === jobId) {
                pollingInterval = setTimeout(poll, currentInterval);
            }

        } catch (error) {
            console.error('Erro no polling:', error);
            currentInterval = Math.min(MAX_POLLING_INTERVAL, currentInterval * 2);
            if (currentJobId === jobId) {
                pollingInterval = setTimeout(poll, currentInterval);
            }
        }
    };

    poll();
}


async function checkJobStatus(jobId) {
    try {
        const response = await fetch(`${API_URL}/job-status/${jobId}`, {
            method: 'GET',
            mode: 'cors',
            cache: 'no-cache',
            headers: { 'Accept': 'application/json' }
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const statusData = await response.json();
        updateProgressUI(statusData);

        if (statusData.status === 'completed') {
            handleJobCompleted(statusData);
            return null;
        } else if (statusData.status === 'failed') {
            handleJobFailed(statusData);
            return null;
        }

        return statusData;

    } catch (error) {
        console.warn('Erro ao verificar status:', error);
        updateProgressUI({
            status: 'processing',
            progress: 0,
            current_step: `Problema de conexão... (tentativa ${pollingAttempts})`,
            message: 'Tentando reconectar'
        });
        throw error;
    }
}


function stopPolling() {
    if (pollingInterval) {
        clearTimeout(pollingInterval);
        pollingInterval = null;
    }
    pollingAttempts = 0;
    currentJobId = null;
}


function updateProgressUI(statusData) {
    const progressBar = document.getElementById('progressBar');
    const progressText = document.getElementById('progressText');
    const currentStep = document.getElementById('currentStep');
    const progressPercent = document.getElementById('progressPercent');
    const pollingInfo = document.getElementById('pollingInfo');

    if (progressBar) {
        progressBar.style.width = `${statusData.progress}%`;
        progressBar.setAttribute('aria-valuenow', statusData.progress);

        progressBar.className = 'progress-bar progress-bar-striped progress-bar-animated';
        if (statusData.status === 'pending') {
            progressBar.classList.add('bg-secondary');
        } else if (statusData.status === 'processing') {
            progressBar.classList.add('bg-info');
        } else if (statusData.status === 'classifying') {
            progressBar.classList.add('bg-warning');
        } else if (statusData.status === 'completed') {
            progressBar.classList.add('bg-success');
        } else if (statusData.status === 'failed') {
            progressBar.classList.add('bg-danger');
        } else {
            progressBar.classList.add('bg-primary');
        }
    }

    if (progressText) {
        progressText.textContent = statusData.message;
    }

    if (currentStep) {
        currentStep.textContent = getStepEmoji(statusData.status) + ' ' + statusData.current_step;
    }

    if (progressPercent) {
        progressPercent.textContent = `${statusData.progress}%`;
    }

    if (pollingInfo) {
        pollingInfo.textContent = `Tentativa ${pollingAttempts} • ${new Date().toLocaleTimeString()}`;
    }
}


function getStepEmoji(status) {
    const emojis = {
        'pending': '⏳',
        'processing': '⚡',
        'extracting_text': '📄',
        'classifying': '🤖',
        'generating_response': '💬',
        'completed': '✅',
        'failed': '❌'
    };
    return emojis[status] || '⚡';
}


function handleJobCompleted(statusData) {
    console.log('Job completado!');
    stopPolling();
    hideLoading();

    if (statusData.result) {
        showResults(statusData.result);
    }
}

function handleJobFailed(statusData) {
    console.error('Job falhou:', statusData.error);
    stopPolling();
    hideLoading();
    showError(`Erro no processamento: ${statusData.error}`);
    cleanupJob(statusData.job_id);
}

function stopPolling() {
    if (pollingInterval) {
        clearTimeout(pollingInterval);
        pollingInterval = null;
    }
    currentJobId = null;
    pollingAttempts = 0;
}

async function cleanupJob(jobId) {
    try {
        const response = await fetch(`${API_URL}/job/${jobId}`, {
            method: 'DELETE',
            mode: 'cors',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            }
        });

        if (response.ok) {
            console.log('Job limpo do servidor');
        } else {
            console.warn('Falha ao limpar job:', response.status);
        }
    } catch (error) {
        console.warn('Não foi possível limpar job do servidor:', error);
    }
}

function showLoadingWithSteps() {
    const loadingDiv = document.getElementById('loading');
    loadingDiv.innerHTML = `
        <div class="text-center">
            <div class="mb-4">
                <div class="spinner-border text-primary mb-3" role="status">
                    <span class="visually-hidden">Processando...</span>
                </div>
            </div>
            
            <div class="progress mb-3" style="height: 12px; border-radius: 6px;">
                <div id="progressBar" class="progress-bar progress-bar-striped progress-bar-animated bg-info" 
                     role="progressbar" style="width: 0%" aria-valuenow="0" aria-valuemin="0" aria-valuemax="100">
                </div>
            </div>
            
            <div class="row">
                <div class="col-12">
                    <p id="currentStep" class="mb-1 fw-bold text-primary">⏳ Iniciando processamento...</p>
                    <p id="progressText" class="mb-2 text-muted small">Preparando para processar seu email</p>
                    <p id="progressPercent" class="mb-0 text-success fw-bold fs-5">0%</p>
                </div>
            </div>
            
            <div class="mt-3">
                <small class="text-muted">
                    <i class="fas fa-info-circle me-1"></i>
                    Processamento em tempo real • Não feche esta página
                </small>
            </div>
        </div>
    `;
    loadingDiv.style.display = 'block';
}

function showLoading() {
    showLoadingWithSteps();
}

function hideLoading() {
    const loadingDiv = document.getElementById('loading');
    loadingDiv.style.display = 'none';
    loadingDiv.innerHTML = '';
}


function showResults(data) {
    const resultsDiv = document.getElementById('results');
    const categoryBadge = document.getElementById('categoryBadge');
    const confidenceBar = document.getElementById('confidenceBar');
    const confidenceText = document.getElementById('confidenceText');
    const suggestedResponse = document.getElementById('suggestedResponse');
    const processedText = document.getElementById('processedText');
    const originalLength = document.getElementById('originalLength');

    categoryBadge.textContent = data.category;
    categoryBadge.className = `badge fs-6 ${data.category === 'Produtivo' ? 'bg-success' : 'bg-warning'}`;

    const confidencePercent = Math.round(data.confidence * 100);
    confidenceBar.style.width = `${confidencePercent}%`;
    confidenceBar.className = `progress-bar ${confidencePercent > 70 ? 'bg-success' : confidencePercent > 40 ? 'bg-warning' : 'bg-danger'}`;
    confidenceText.textContent = `${confidencePercent}% de confiança`;

    suggestedResponse.textContent = data.suggested_response;
    processedText.textContent = data.processed_text;
    originalLength.textContent = `Texto original: ${data.original_length} caracteres`;

    resultsDiv.style.display = 'block';
    setTimeout(() => {
        resultsDiv.scrollIntoView({ behavior: 'smooth' });
    }, 300);
}

function showError(message) {
    const errorDiv = document.getElementById('error');
    const errorMessage = document.getElementById('errorMessage');

    errorMessage.textContent = message;
    errorDiv.style.display = 'block';

    errorDiv.scrollIntoView({ behavior: 'smooth' });
}

function hideError() {
    document.getElementById('error').style.display = 'none';
}

function hideResults() {
    document.getElementById('results').style.display = 'none';
}

function resetForm() {
    stopPolling();

    document.getElementById('emailText').value = '';
    document.getElementById('emailFile').value = '';
    hideResults();
    hideError();
    hideLoading();

    const textTab = new bootstrap.Tab(document.getElementById('text-tab'));
    textTab.show();

    const fileTab = document.getElementById('file-tab');
    if (fileTab) {
        fileTab.querySelector('button').innerHTML = '<i class="fas fa-file me-1"></i>Arquivo';
    }
}

async function testConnection() {
    console.log('Testando conexão com API...');
    try {
        const response = await fetch(`${API_URL}/health`, {
            method: 'GET',
            mode: 'cors'
        });

        if (response.ok) {
            const data = await response.json();
            console.log('API está funcionando:', data);
            return true;
        } else {
            console.error('API não está saudável');
            return false;
        }
    } catch (error) {
        console.error('Erro no health check:', error);
        return false;
    }
}

async function checkAPIHealth() {
    const isHealthy = await testConnection();
    if (!isHealthy) {
        console.warn('API não está acessível no momento');
    }
}

document.addEventListener('DOMContentLoaded', function () {
    document.getElementById('emailText').addEventListener('keypress', function (e) {
        if (e.key === 'Enter' && e.ctrlKey) {
            classifyText();
        }
    });

    const fileInput = document.getElementById('emailFile');
    const fileTab = document.getElementById('file-tab');

    if (fileInput && fileTab) {
        fileInput.addEventListener('change', function () {
            if (this.files.length > 0) {
                const fileName = this.files[0].name;
                const maxLength = 20;
                const displayName = fileName.length > maxLength
                    ? fileName.substring(0, maxLength) + '...'
                    : fileName;

                fileTab.querySelector('button').innerHTML =
                    `<i class="fas fa-file me-1"></i>${displayName}`;
            } else {
                fileTab.querySelector('button').innerHTML =
                    '<i class="fas fa-file me-1"></i>Arquivo';
            }
        });
    }

    checkAPIHealth();
  
    window.addEventListener('beforeunload', function () {
        stopPolling();
    });
});