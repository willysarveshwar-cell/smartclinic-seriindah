-- MySQL schema for Smart Clinic
-- Import this file in phpMyAdmin to create tables from scratch.

-- Users table
CREATE TABLE IF NOT EXISTS users (
  userId INT PRIMARY KEY AUTO_INCREMENT,
  fullName VARCHAR(100) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  role VARCHAR(20) NOT NULL,
  linked_patient_id INT NULL,
  email_verified TINYINT DEFAULT 0,
  verification_token VARCHAR(128),
  verification_expires_at DATETIME,
  refresh_token VARCHAR(255),
  refresh_expires_at DATETIME,
  last_login_at DATETIME
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Patients table
CREATE TABLE IF NOT EXISTS patients (
  id INT PRIMARY KEY AUTO_INCREMENT,
  full_name VARCHAR(100) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  phone VARCHAR(30),
  ic_number VARCHAR(30) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- date_of_birth and gender added for patient management module

-- Doctors table
CREATE TABLE IF NOT EXISTS doctors (
  id INT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(100) NOT NULL,
  specialization VARCHAR(100) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  avg_consultation_minutes INT DEFAULT 15
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Appointments table
-- check_in_token equals queue_number (simple memorable number 1-1999), unique per date
CREATE TABLE IF NOT EXISTS appointments (
  id INT PRIMARY KEY AUTO_INCREMENT,
  patient_name VARCHAR(100) NOT NULL,
  ic_number VARCHAR(30) NOT NULL,
  patient_email VARCHAR(255),
  patient_phone VARCHAR(30),
  doctor_id INT NOT NULL,
  appointment_date VARCHAR(10) NOT NULL,
  appointment_time VARCHAR(10) NOT NULL,
  queue_number INT NOT NULL,
  status VARCHAR(30) DEFAULT 'Waiting',
  description TEXT,
  patient_id INT,
  check_in_token VARCHAR(10),
  check_in_confirmed TINYINT DEFAULT 0,
  checked_in_at DATETIME,
  started_at DATETIME,
  completed_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME,
  UNIQUE KEY uq_checkin (appointment_date, check_in_token),
  FOREIGN KEY (doctor_id) REFERENCES doctors(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS doctor_availability (
  id INT PRIMARY KEY AUTO_INCREMENT,
  doctor_id INT NOT NULL,
  day_of_week TINYINT NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  is_active TINYINT DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_doctor_day_time (doctor_id, day_of_week, start_time, end_time),
  FOREIGN KEY (doctor_id) REFERENCES doctors(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS doctor_leaves (
  id INT PRIMARY KEY AUTO_INCREMENT,
  doctor_id INT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  reason TEXT,
  status VARCHAR(20) DEFAULT 'Pending',
  requested_by_user_id INT NULL,
  reviewed_by_user_id INT NULL,
  review_notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  reviewed_at DATETIME NULL,
  FOREIGN KEY (doctor_id) REFERENCES doctors(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS medical_records (
  id INT PRIMARY KEY AUTO_INCREMENT,
  doctor_id INT NOT NULL,
  patient_id INT NOT NULL,
  appointment_id INT NOT NULL,
  diagnosis TEXT,
  prescriptions TEXT,
  notes TEXT,
  visit_date DATE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NULL,
  UNIQUE KEY uq_medical_record_appointment (appointment_id),
  FOREIGN KEY (doctor_id) REFERENCES doctors(id) ON DELETE CASCADE,
  FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE,
  FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Notifications table
CREATE TABLE IF NOT EXISTS notifications (
  id INT PRIMARY KEY AUTO_INCREMENT,
  appointment_id INT,
  event_type VARCHAR(64) NULL,
  channel VARCHAR(20) NOT NULL,
  recipient VARCHAR(255),
  message TEXT,
  sent_status VARCHAR(20) DEFAULT 'logged',
  details JSON NULL,
  sent_at DATETIME NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS notification_settings (
  id INT PRIMARY KEY,
  email_enabled TINYINT DEFAULT 1,
  sms_enabled TINYINT DEFAULT 0,
  appointment_confirmation_email TINYINT DEFAULT 1,
  appointment_confirmation_sms TINYINT DEFAULT 0,
  appointment_reminder_email TINYINT DEFAULT 1,
  appointment_reminder_sms TINYINT DEFAULT 0,
  queue_updates_enabled TINYINT DEFAULT 1,
  missed_appointment_enabled TINYINT DEFAULT 1,
  reminder_lead_minutes INT DEFAULT 1440,
  missed_grace_minutes INT DEFAULT 30,
  smtp_server VARCHAR(255) NULL,
  smtp_port INT NULL,
  smtp_username VARCHAR(255) NULL,
  sms_provider VARCHAR(50) NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Authentication audit logs
CREATE TABLE IF NOT EXISTS auth_audit_logs (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  event_type VARCHAR(64) NOT NULL,
  status VARCHAR(20) NOT NULL,
  user_id INT NULL,
  email VARCHAR(255) NULL,
  role VARCHAR(20) NULL,
  ip_address VARCHAR(64) NULL,
  user_agent VARCHAR(255) NULL,
  details JSON NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Indexes
CREATE INDEX idx_apts_doctor_date_time ON appointments(doctor_id, appointment_date, appointment_time);
CREATE INDEX idx_apts_date_status ON appointments(appointment_date, status);
CREATE INDEX idx_auth_audit_created ON auth_audit_logs(created_at);
CREATE INDEX idx_auth_audit_email ON auth_audit_logs(email);
CREATE INDEX idx_auth_audit_user ON auth_audit_logs(user_id);

-- Sample seed data
INSERT IGNORE INTO users (fullName, email, password, role, email_verified) VALUES
  ('Admin User', 'admin@clinic.com', 'admin123', 'Admin', 1),
  ('Dr. John Doe', 'doctor@example.com', 'password123', 'Doctor', 1);

INSERT IGNORE INTO doctors (name, specialization, email, password) VALUES
  ('Dr. John Doe', 'General Medicine', 'doctor@example.com', 'password123');