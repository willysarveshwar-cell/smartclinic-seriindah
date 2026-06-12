// Get logged-in doctor from localStorage
const doctor = JSON.parse(localStorage.getItem("doctor"));

// If not logged in, redirect
if (!doctor) {
  window.location.href = "doctor-login.html";
}

// Show welcome message
document.addEventListener("DOMContentLoaded", () => {
  const welcome = document.getElementById("welcome");

  if (welcome) {
    welcome.innerText = `Welcome Dr. ${doctor.name} (${doctor.specialization})`;
  }

  loadQueue();
  setInterval(loadQueue, 5000);

  if (window.io) {
    const socket = window.io("http://localhost:5000");
    socket.on("queue:updated", () => loadQueue());
  }
});

// Load queue data
async function loadQueue() {
  try {
    const res = await fetch(
      `http://localhost:5000/api/doctors/${doctor.doctorId}/queue`
    );

    const data = await res.json();
    const tbody = document.getElementById("queueBody");
    tbody.innerHTML = "";

    if (!data || data.length === 0) {
      tbody.innerHTML = `<tr><td colspan="3">No patients in queue</td></tr>`;
      return;
    }

    data.forEach(q => {
      const row = document.createElement("tr");
      row.innerHTML = `
        <td>${q.queueNumber}</td>
        <td>${q.patientName}</td>
        <td>${q.status}</td>
      `;
      tbody.appendChild(row);
    });
  } catch (error) {
    console.error("Failed to load queue:", error);
  }
}

// Logout
function logout() {
  localStorage.removeItem("doctor");
  window.location.href = "doctor-login.html";
}
