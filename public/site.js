const views = {
 thread: {file:'workspace-thread.png',alt:'Actual Ambulando conversation thread with human and agent dialogue, scopes and channels, and a voice-note attachment',caption:'Open the thread to talk through the brief with your agent, share a voice note and agree the next step.'},
 tasks: {file:'workspace-tasks.png',alt:'Actual Ambulando task board with five Website launch tasks grouped by state',caption:'See what is moving, what needs review and what comes next, with an owner for each task.'},
 detail: {file:'workspace-task-detail.png',alt:'Actual Ambulando task review with progress comments and a linked launch document',caption:'Inspect the task updates and validation, then follow the linked document for the full response.'},
 document: {file:'workspace-document.png',alt:'Actual Ambulando document review with a visual, a structured table and comments from a human and an agent',caption:'Review a clearly laid-out document, with imagery, a table and human and agent feedback alongside the work.'}
};
function showView(key){const view=views[key];if(!view)return;const path='assets/'+view.file;document.querySelector('#render-image').src=path;document.querySelector('#render-image').alt=view.alt;document.querySelector('#render-caption').textContent=view.caption;for(const id of ['render-link','render-full'])document.getElementById(id).href=path;document.querySelectorAll('[data-view]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.view===key)));}
document.querySelectorAll('[data-view]').forEach(button=>button.addEventListener('click',()=>showView(button.dataset.view)));
document.querySelectorAll('[data-show]').forEach(link=>link.addEventListener('click',()=>showView(link.dataset.show)));
