
DO (
  IN USERNAME NVARCHAR(255) => ?,
  IN USERPASS NVARCHAR(255) => ?,
  IN SCHEMANAME NVARCHAR(255) => ?,
  IN CREATECONTAINER BOOLEAN => ?
)
BEGIN SEQUENTIAL EXECUTION
  DECLARE USER_EXISTS INT;
  DECLARE RETURN_CODE INT;
  DECLARE REQUEST_ID BIGINT;
  DECLARE ALL_MESSAGES _SYS_DI.TT_MESSAGES;
  DECLARE MESSAGES _SYS_DI.TT_MESSAGES;
  DECLARE PRIVILEGES _SYS_DI.TT_API_PRIVILEGES;
  DECLARE SCHEMA_PRIV _SYS_DI.TT_SCHEMA_PRIVILEGES;

  DECLARE IGNOREPARAMS _SYS_DI.TT_PARAMETERS;

  NO_PARAMS = SELECT * FROM _SYS_DI.T_NO_PARAMETERS;

  IGNOREPARAMS =
    SELECT 'IGNORE_DEPLOYED' AS KEY, 'TRUE' AS VALUE FROM DUMMY
    UNION ALL
    SELECT 'IGNORE_WORK' AS KEY, 'TRUE' AS VALUE FROM DUMMY;
  CALL _SYS_DI#{{{GROUP}}}.DROP_CONTAINER(:SCHEMANAME, :IGNOREPARAMS, :RETURN_CODE, :REQUEST_ID, :MESSAGES);
  ALL_MESSAGES = SELECT * FROM :MESSAGES;

  SELECT COUNT(*) INTO USER_EXISTS FROM SYS.USERS WHERE USER_NAME = :USERNAME;
  IF :USER_EXISTS > 0 THEN
    EXEC 'DROP USER ' || :USERNAME || ' CASCADE';
  END IF;

  IF :CREATECONTAINER = TRUE THEN
    EXEC 'CREATE USER ' || :USERNAME || ' PASSWORD ' || :USERPASS || ' NO FORCE_FIRST_PASSWORD_CHANGE SET USERGROUP "{{{GROUP}}}_USERS"';
    EXEC 'GRANT EXECUTE ON SYS.GET_INSUFFICIENT_PRIVILEGE_ERROR_DETAILS TO ' || :USERNAME;

    CALL _SYS_DI#{{{GROUP}}}.CREATE_CONTAINER(:SCHEMANAME, :NO_PARAMS, :RETURN_CODE, :REQUEST_ID, :MESSAGES);
    ALL_MESSAGES = SELECT * FROM :ALL_MESSAGES UNION ALL SELECT * FROM :MESSAGES;
    COMMIT;
    DEFAULT_LIBS = SELECT * FROM _SYS_DI.T_DEFAULT_LIBRARIES;
    CALL _SYS_DI#{{{GROUP}}}.CONFIGURE_LIBRARIES(:SCHEMANAME, :DEFAULT_LIBS, :NO_PARAMS, :RETURN_CODE, :REQUEST_ID, :MESSAGES);
    ALL_MESSAGES = SELECT * FROM :ALL_MESSAGES UNION ALL SELECT * FROM :MESSAGES;
    COMMIT;
    PRIVILEGES =
      SELECT PRIVILEGE_NAME, OBJECT_NAME, PRINCIPAL_SCHEMA_NAME, :USERNAME AS PRINCIPAL_NAME FROM _SYS_DI.T_DEFAULT_CONTAINER_ADMIN_PRIVILEGES 
      UNION ALL
      SELECT PRIVILEGE_NAME, OBJECT_NAME, PRINCIPAL_SCHEMA_NAME, :USERNAME AS PRINCIPAL_NAME FROM _SYS_DI.T_DEFAULT_CONTAINER_USER_PRIVILEGES;

    CALL _SYS_DI#{{{GROUP}}}.GRANT_CONTAINER_API_PRIVILEGES(:SCHEMANAME, :PRIVILEGES, :NO_PARAMS, :RETURN_CODE, :REQUEST_ID, :MESSAGES);
    ALL_MESSAGES = SELECT * FROM :ALL_MESSAGES UNION ALL SELECT * FROM :MESSAGES;
    COMMIT;
    SCHEMA_PRIV = SELECT PRIVILEGE_NAME, '' AS PRINCIPAL_SCHEMA_NAME, :USERNAME AS PRINCIPAL_NAME FROM (
      SELECT 'SELECT' AS PRIVILEGE_NAME FROM DUMMY UNION ALL
      SELECT 'INSERT' AS PRIVILEGE_NAME FROM DUMMY UNION ALL
      SELECT 'UPDATE' AS PRIVILEGE_NAME FROM DUMMY UNION ALL
      SELECT 'DELETE' AS PRIVILEGE_NAME FROM DUMMY UNION ALL
      SELECT 'EXECUTE' AS PRIVILEGE_NAME FROM DUMMY UNION ALL
      SELECT 'CREATE TEMPORARY TABLE' AS PRIVILEGE_NAME FROM DUMMY UNION ALL
      SELECT 'CREATE ANY' AS PRIVILEGE_NAME FROM DUMMY
    );

    CALL _SYS_DI#{{{GROUP}}}.GRANT_CONTAINER_SCHEMA_PRIVILEGES(:SCHEMANAME, :SCHEMA_PRIV, :NO_PARAMS, :RETURN_CODE, :REQUEST_ID, :MESSAGES);
    ALL_MESSAGES = SELECT * FROM :ALL_MESSAGES UNION ALL SELECT * FROM :MESSAGES;
    COMMIT;
  END IF;
  
  SELECT * FROM :ALL_MESSAGES;
END;
