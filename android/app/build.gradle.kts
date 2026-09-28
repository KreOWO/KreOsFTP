import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val signingProperties = Properties().apply {
    rootProject.file("keystore.properties").inputStream().use(::load)
}

fun signingValue(environmentName: String, propertyName: String): String =
    System.getenv(environmentName)?.takeIf(String::isNotBlank)
        ?: signingProperties.getProperty(propertyName)
        ?: error("Missing signing property: $propertyName")

android {
    namespace = "com.kreos.ftp"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.kreos.ftp"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        create("communityRelease") {
            storeFile = rootProject.file(signingValue("KREOSFTP_KEYSTORE_FILE", "storeFile"))
            storePassword = signingValue("KREOSFTP_KEYSTORE_PASSWORD", "storePassword")
            keyAlias = signingValue("KREOSFTP_KEY_ALIAS", "keyAlias")
            keyPassword = signingValue("KREOSFTP_KEY_PASSWORD", "keyPassword")
            enableV1Signing = true
            enableV2Signing = true
            enableV3Signing = true
            enableV4Signing = true
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            signingConfig = signingConfigs.getByName("communityRelease")
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    packaging {
        resources.excludes += setOf(
            "META-INF/DEPENDENCIES",
            "META-INF/LICENSE*",
            "META-INF/NOTICE*"
        )
    }
}

dependencies {
    implementation("androidx.documentfile:documentfile:1.1.0")
    implementation("commons-net:commons-net:3.13.0")
    implementation("com.github.mwiede:jsch:2.28.7")

    testImplementation("junit:junit:4.13.2")
}
