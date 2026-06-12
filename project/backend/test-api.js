const http = require('http');
const db = require('./db');

function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const json = body ? JSON.stringify(body) : '';
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(json)
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const req = http.request({
      host: 'localhost',
      port: 5000,
      path,
      method,
      headers,
      timeout: 15000
    }, res => {
      let response = '';
      res.on('data', chunk => response += chunk);
      res.on('end', () => {
        let body = null;
        try { body = response ? JSON.parse(response) : null; } catch (err) { return reject(err); }
        resolve({ status: res.statusCode, body });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('Request timed out'));
    });

    if (json) req.write(json);
    req.end();
  });
}

async function validateRow(table, id) {
  const rows = await db.queryAsync(`SELECT * FROM ${table} WHERE id = ? LIMIT 1`, [id]);
  return rows.length > 0 ? rows[0] : null;
}

async function run() {
  console.log('Starting backend CRUD sync tests...');

  const login = await request('POST', '/api/admin/login', { email: 'admin@clinic.com', password: 'admin123' });
  if (login.status !== 200 || !login.body || !login.body.token) {
    throw new Error(`Admin login failed: ${JSON.stringify(login)}`);
  }

  const token = login.body.token;
  console.log('Admin login OK');

  const uniqueSuffix = Date.now();
  const doctorName = `AutoDoctor ${uniqueSuffix}`;
  const doctorEmail = `autodoc${uniqueSuffix}@clinic.test`;

  const createDoctor = await request('POST', '/api/doctors', {
    name: doctorName,
    specialization: 'Test Medicine',
    email: doctorEmail,
    password: 'Test1234'
  }, token);
  if (createDoctor.status !== 201) {
    throw new Error(`Create doctor failed: ${JSON.stringify(createDoctor)}`);
  }
  const doctorId = createDoctor.body.doctorId;
  console.log('Doctor created:', doctorId);

  const doctorRow = await validateRow('doctors', doctorId);
  if (!doctorRow) throw new Error('Doctor row missing in doctors table after creation');
  const userRows = await db.queryAsync('SELECT * FROM users WHERE LOWER(email) = ? AND LOWER(role) = ? LIMIT 1', [doctorEmail.toLowerCase(), 'doctor']);
  if (userRows.length === 0) throw new Error('Doctor user row missing in users table after creation');
  console.log('Doctor create sync verified in users table');

  const updatedDoctorName = doctorName + ' Updated';
  const updatedDoctorEmail = `updated-${doctorEmail}`;
  const updateDoctor = await request('PUT', `/api/doctors/${doctorId}`, {
    name: updatedDoctorName,
    specialization: 'Updated Medicine',
    email: updatedDoctorEmail,
    password: 'NewPass1234'
  }, token);
  if (updateDoctor.status !== 200) {
    throw new Error(`Update doctor failed: ${JSON.stringify(updateDoctor)}`);
  }
  console.log('Doctor update API OK');

  const updatedDoctorRow = await validateRow('doctors', doctorId);
  if (!updatedDoctorRow || updatedDoctorRow.name !== updatedDoctorName || updatedDoctorRow.email !== updatedDoctorEmail) {
    throw new Error('Doctor row mismatch after update');
  }
  const updatedUserRows = await db.queryAsync('SELECT * FROM users WHERE LOWER(email) = ? AND LOWER(role) = ? LIMIT 1', [updatedDoctorEmail.toLowerCase(), 'doctor']);
  if (updatedUserRows.length === 0 || updatedUserRows[0].fullName !== updatedDoctorName) {
    throw new Error('Doctor user row mismatch after update');
  }
  console.log('Doctor update sync verified');

  const patientName = `AutoPatient ${uniqueSuffix}`;
  const patientEmail = `autopat${uniqueSuffix}@clinic.test`;

  const createPatient = await request('POST', '/api/patients/admin/create', {
    fullName: patientName,
    email: patientEmail,
    phone: '+60123456789',
    icNumber: `IC${uniqueSuffix}`,
    dateOfBirth: '1990-01-01',
    gender: 'Other',
    password: 'Patient1234'
  }, token);
  if (createPatient.status !== 201) {
    throw new Error(`Create patient failed: ${JSON.stringify(createPatient)}`);
  }
  const patientId = createPatient.body.patient.id;
  console.log('Patient created:', patientId);

  const patientRow = await validateRow('patients', patientId);
  if (!patientRow) throw new Error('Patient row missing after creation');
  const patientUserRows = await db.queryAsync('SELECT * FROM users WHERE linked_patient_id = ? LIMIT 1', [patientId]);
  if (patientUserRows.length === 0) throw new Error('Patient user row missing after creation');
  console.log('Patient create sync verified');

  const updatePatient = await request('PUT', `/api/patients/${patientId}`, {
    fullName: `${patientName} Updated`,
    email: `updated-${patientEmail}`
  }, token);
  if (updatePatient.status !== 200) {
    throw new Error(`Update patient failed: ${JSON.stringify(updatePatient)}`);
  }
  const updatedPatientRow = await validateRow('patients', patientId);
  if (!updatedPatientRow || updatedPatientRow.full_name !== `${patientName} Updated`) {
    throw new Error('Patient row mismatch after update');
  }
  const updatedPatientUserRows = await db.queryAsync('SELECT * FROM users WHERE linked_patient_id = ? LIMIT 1', [patientId]);
  if (updatedPatientUserRows.length === 0 || updatedPatientUserRows[0].fullName !== `${patientName} Updated`) {
    throw new Error('Patient user row mismatch after update');
  }
  console.log('Patient update sync verified');

  const appointmentDate = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const createAppointment = await request('POST', '/api/appointments', {
    patient_name: `${patientName} Updated`,
    ic_number: `IC${uniqueSuffix}`,
    doctor_id: doctorId,
    appointment_date: appointmentDate,
    appointment_time: '09:00',
    patient_email: `updated-${patientEmail}`,
    patient_phone: '+60123456789',
    description: 'Test appointment sync'
  }, token);
  if (createAppointment.status !== 200 || !createAppointment.body.success) {
    throw new Error(`Create appointment failed: ${JSON.stringify(createAppointment)}`);
  }
  const appointmentId = createAppointment.body.appointmentId;
  console.log('Appointment created:', appointmentId);

  const appointmentRow = await validateRow('appointments', appointmentId);
  if (!appointmentRow) throw new Error('Appointment row missing after creation');
  console.log('Appointment create sync verified');

  const updateAppointment = await request('PUT', `/api/appointments/${appointmentId}`, {
    description: 'Updated test appointment',
    status: 'Waiting'
  }, token);
  if (updateAppointment.status !== 200) {
    throw new Error(`Update appointment failed: ${JSON.stringify(updateAppointment)}`);
  }
  const updatedAppointment = await validateRow('appointments', appointmentId);
  if (!updatedAppointment || updatedAppointment.description !== 'Updated test appointment') {
    throw new Error('Appointment row mismatch after update');
  }
  console.log('Appointment update sync verified');

  const deleteAppointment = await request('DELETE', `/api/appointments/${appointmentId}`, null, token);
  if (deleteAppointment.status !== 200) {
    throw new Error(`Delete appointment failed: ${JSON.stringify(deleteAppointment)}`);
  }
  const deletedAppointment = await validateRow('appointments', appointmentId);
  if (deletedAppointment) throw new Error('Appointment still exists after delete');
  console.log('Appointment delete verified');

  const deletePatient = await request('DELETE', `/api/patients/${patientId}`, null, token);
  if (deletePatient.status !== 200) {
    throw new Error(`Delete patient failed: ${JSON.stringify(deletePatient)}`);
  }
  const deletedPatientRow = await validateRow('patients', patientId);
  if (deletedPatientRow) throw new Error('Patient still exists after delete');
  const deletedPatientUser = await db.queryAsync('SELECT * FROM users WHERE linked_patient_id = ? LIMIT 1', [patientId]);
  if (deletedPatientUser.length > 0) throw new Error('Patient user still exists after delete');
  console.log('Patient delete verified');

  const deleteDoctor = await request('DELETE', `/api/doctors/${doctorId}`, null, token);
  if (deleteDoctor.status !== 200) {
    throw new Error(`Delete doctor failed: ${JSON.stringify(deleteDoctor)}`);
  }
  const deletedDoctorRow = await validateRow('doctors', doctorId);
  if (deletedDoctorRow) throw new Error('Doctor still exists after delete');
  const deletedDoctorUser = await db.queryAsync('SELECT * FROM users WHERE LOWER(email) = ? AND LOWER(role) = ? LIMIT 1', [updatedDoctorEmail.toLowerCase(), 'doctor']);
  if (deletedDoctorUser.length > 0) throw new Error('Doctor user still exists after delete');
  console.log('Doctor delete verified');

  console.log('All CRUD sync tests passed successfully.');
  process.exit(0);
}

run().catch(error => {
  console.error('TEST FAILED:', error.message || error);
  process.exit(1);
});